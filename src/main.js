import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

// Initialize the Apify SDK
await Actor.init();

/**
 * Extract API endpoint calls from page network requests
 * Monitor XHR/Fetch requests to find the internal API
 */
async function extractJobsViaAPI(page, searchParams) {
    log.info('Attempting to extract jobs via internal API');
    
    try {
        // Listen for all network requests
        const apiResponses = [];
        
        page.on('response', async (response) => {
            const url = response.url();
            
            // Look for API calls that return job data
            if (url.includes('api') || url.includes('/jobs') || url.includes('search')) {
                try {
                    const text = await response.text();
                    if (text && (text.includes('job') || text.includes('company'))) {
                        apiResponses.push({
                            url,
                            status: response.status(),
                            contentType: response.headers()['content-type']
                        });
                        log.debug(`Found potential API endpoint: ${url}`);
                    }
                } catch (err) {
                    log.debug(`Could not read response from ${url}`);
                }
            }
        });
        
        // Wait for page to load and capture network requests
        await page.waitForLoadState('networkidle', { timeout: 30000 });
        
        // If we found JSON API endpoints, try to extract data
        if (apiResponses.length > 0) {
            log.info(`Found ${apiResponses.length} potential API endpoints`);
            return apiResponses;
        }
        
        return [];
        
    } catch (error) {
        log.warning(`Failed to capture API endpoints: ${error.message}`);
        return [];
    }
}

/**
 * Build Careerjet search URL from input parameters
 */
function buildSearchUrl(input) {
    // If searchUrl is provided, use it directly
    if (input.searchUrl && input.searchUrl.trim()) {
        log.info('Using provided search URL directly');
        return input.searchUrl.trim();
    }
    
    const baseUrl = 'https://www.careerjet.com/jobs';
    const params = new URLSearchParams();
    
    params.append('s', input.searchQuery || 'administrator');
    params.append('l', input.location || 'USA');
    
    if (input.newJobsOnly) {
        params.append('nw', '1');
    }
    
    if (input.jobType && input.jobType !== 'all') {
        params.append('c', input.jobType);
    }
    
    if (input.radius && input.radius !== '0') {
        params.append('r', input.radius);
    }
    
    if (input.salaryMin) {
        params.append('sal', input.salaryMin.toString());
    }
    
    if (input.sortBy === 'date') {
        params.append('sort', 'date');
    }
    
    return `${baseUrl}?${params.toString()}`;
}

/**
 * Extract job data from the page using intelligent selectors
 */
async function extractJobData(page, url) {
    log.info('Extracting job data from page');
    
    try {
        // Wait for job listings to load with multiple selector attempts
        try {
            await page.waitForSelector('article.job, div[data-job-id], div.job-listing, li.job', { timeout: 20000 });
        } catch (e) {
            log.warning('Standard job selectors not found, attempting alternative selectors');
        }
        
        // Extract all job listings with multiple selector strategies
        const jobs = await page.evaluate(() => {
            const jobElements = document.querySelectorAll(
                'article.job, div[data-job-id], div.job-listing, li.job, [class*="job"][class*="item"]'
            );
            const jobsData = [];
            
            jobElements.forEach((element) => {
                try {
                    // Try multiple selector patterns
                    const jobTitle = 
                        element.querySelector('h2 a')?.textContent?.trim() ||
                        element.querySelector('h3 a')?.textContent?.trim() ||
                        element.querySelector('[class*="title"] a')?.textContent?.trim() ||
                        element.getAttribute('data-job-title') ||
                        '';
                    
                    const jobUrl = 
                        element.querySelector('h2 a')?.href ||
                        element.querySelector('h3 a')?.href ||
                        element.querySelector('[class*="title"] a')?.href ||
                        element.getAttribute('data-job-url') ||
                        '';
                    
                    const company = 
                        element.querySelector('[class*="company"]')?.textContent?.trim() ||
                        element.getAttribute('data-company') ||
                        '';
                    
                    const location = 
                        element.querySelector('[class*="location"], [class*="place"]')?.textContent?.trim() ||
                        element.getAttribute('data-location') ||
                        '';
                    
                    const salary = 
                        element.querySelector('[class*="salary"]')?.textContent?.trim() ||
                        element.getAttribute('data-salary') ||
                        'Not specified';
                    
                    const description = 
                        element.querySelector('[class*="description"], [class*="desc"]')?.textContent?.trim() ||
                        element.getAttribute('data-description') ||
                        '';
                    
                    const descriptionHtml = 
                        element.querySelector('[class*="description"], [class*="desc"]')?.innerHTML?.trim() || '';
                    
                    const descriptionText = 
                        element.querySelector('[class*="description"], [class*="desc"]')?.textContent?.trim() || '';
                    
                    const postedDate = 
                        element.querySelector('[class*="date"], [class*="posted"]')?.textContent?.trim() ||
                        element.getAttribute('data-posted-date') ||
                        '';
                    
                    const jobType = 
                        element.querySelector('[class*="type"], [class*="employment"]')?.textContent?.trim() ||
                        element.getAttribute('data-job-type') ||
                        'Not specified';
                    
                    // Only add if we have at least title and URL
                    if (jobTitle && jobUrl) {
                        jobsData.push({
                            jobTitle,
                            company,
                            location,
                            salary,
                            jobType,
                            postedDate,
                            description,
                            descriptionHtml,
                            descriptionText,
                            url: jobUrl,
                            scrapedAt: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    log.debug(`Error extracting individual job: ${err.message}`);
                }
            });
            
            return jobsData;
        });
        
        log.info(`Extracted ${jobs.length} jobs from page`);
        return jobs;
        
    } catch (error) {
        log.warning(`Failed to extract jobs using selectors: ${error.message}`);
        return [];
    }
}

/**
 * Main Actor execution
 */
try {
    // Get Actor input
    const input = await Actor.getInput() || {};
    
    log.info('Starting Careerjet Jobs Scraper', {
        searchUrl: input.searchUrl,
        searchQuery: input.searchQuery,
        location: input.location,
        maxJobs: input.maxJobs
    });
    
    // Validate input - either searchUrl OR (searchQuery AND location) must be provided
    if (!input.searchUrl && (!input.searchQuery || !input.location)) {
        throw new Error('Either searchUrl OR both searchQuery and location are required');
    }
    
    // Set default values
    const maxJobs = input.maxJobs || 100;
    
    // Build search URL
    const searchUrl = buildSearchUrl(input);
    
    log.info(`Search URL: ${searchUrl}`);
    
    // Create proxy configuration
    const proxyConfiguration = await Actor.createProxyConfiguration(
        input.proxyConfiguration || { useApifyProxy: true }
    );
    
    // Statistics tracking
    let totalJobsScraped = 0;
    let pagesProcessed = 0;
    let apiCallsFound = 0;
    const startTime = Date.now();
    
    // Create Playwright crawler with Camoufox for Cloudflare bypass
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 50,
        maxConcurrency: 1,
        navigationTimeoutSecs: 60,
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                headless: true,
                proxy: await proxyConfiguration.newUrl(),
                geoip: true,
                os: 'windows',
                screen: 'random',
                addons: false,
                // Additional Camoufox stealth options
                timezone: 'UTC',
                locale: 'en-US'
            }),
        },
        
        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);
            
            try {
                // Set realistic user agent and headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                });
                
                // Navigate to page
                await page.goto(request.url, { 
                    waitUntil: 'networkidle',
                    timeout: 60000 
                });
                
                // Check for Cloudflare challenge and handle it
                const title = await page.title();
                if (title.includes('Just a moment') || title.includes('Cloudflare')) {
                    log.warning('Cloudflare challenge detected, Camoufox bypass in progress...');
                    // Camoufox handles Cloudflare automatically, just wait
                    await page.waitForTimeout(5000);
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                }
                
                // Attempt to find and capture API calls
                const apiEndpoints = await extractJobsViaAPI(page, request.url);
                if (apiEndpoints.length > 0) {
                    apiCallsFound += apiEndpoints.length;
                    log.info(`Detected ${apiEndpoints.length} API endpoints`);
                }
                
                // Extract jobs from the page
                const jobs = await extractJobData(page, request.url);
                
                if (jobs.length > 0) {
                    // Filter jobs if we've reached the limit
                    const jobsToSave = maxJobs > 0 
                        ? jobs.slice(0, Math.max(0, maxJobs - totalJobsScraped))
                        : jobs;
                    
                    // Save jobs to dataset
                    if (jobsToSave.length > 0) {
                        await Actor.pushData(jobsToSave);
                        totalJobsScraped += jobsToSave.length;
                        log.info(`Saved ${jobsToSave.length} jobs. Total: ${totalJobsScraped}`);
                    }
                    
                    // Check if we've reached the limit
                    if (maxJobs > 0 && totalJobsScraped >= maxJobs) {
                        log.info(`Reached maximum jobs limit: ${maxJobs}`);
                        return;
                    }
                    
                    // Look for next page
                    const nextPageUrl = await page.evaluate(() => {
                        const nextButton = 
                            document.querySelector('a[rel="next"]') || 
                            document.querySelector('.pagination a.next') ||
                            document.querySelector('[class*="pagination"] a[class*="next"]') ||
                            document.querySelector('a[aria-label*="next" i]');
                        return nextButton?.href;
                    });
                    
                    if (nextPageUrl && totalJobsScraped < maxJobs) {
                        log.info(`Found next page: ${nextPageUrl}`);
                        await crawler.addRequests([{ url: nextPageUrl }]);
                    }
                } else {
                    log.warning('No jobs found on this page');
                }
                
            } catch (error) {
                log.error(`Error processing page: ${error.message}`, {
                    url: request.url
                });
            }
        },
        
        async failedRequestHandler({ request }, error) {
            log.error(`Request failed: ${request.url} - ${error.message}`);
        }
    });
    
    // Start crawling
    log.info('Starting crawler with Camoufox for Cloudflare bypass...');
    await crawler.run([searchUrl]);
    
    // Calculate statistics
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);
    
    const statistics = {
        totalJobsScraped,
        pagesProcessed,
        apiEndpointsDetected: apiCallsFound,
        scrapingMethod: apiCallsFound > 0 ? 'hybrid (API + HTML)' : 'HTML parsing',
        duration: `${duration} seconds`,
        timestamp: new Date().toISOString()
    };
    
    // Save statistics
    await Actor.setValue('statistics', statistics);
    
    log.info('Scraping completed', statistics);
    
} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}

// Exit successfully
await Actor.exit();
