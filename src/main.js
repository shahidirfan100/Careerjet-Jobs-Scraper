import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';

// Initialize the Apify SDK
await Actor.init();

/**
 * Extract jobs from JSON-LD structured data (Primary method)
 * Google Jobs and many sites use this schema
 */
async function extractJobsViaJsonLD(page) {
    log.info('Attempting to extract jobs via JSON-LD');

    try {
        const jsonLdScripts = await page.$$eval('script[type="application/ld+json"]', scripts =>
            scripts.map(script => script.textContent)
        );

        const jobs = [];

        for (const scriptContent of jsonLdScripts) {
            try {
                const data = JSON.parse(scriptContent);

                // Handle array of job postings
                if (Array.isArray(data)) {
                    for (const item of data) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle single job posting
                else if (data['@type'] === 'JobPosting') {
                    jobs.push(parseJobPosting(data));
                }
                // Handle @graph structure
                else if (data['@graph']) {
                    for (const item of data['@graph']) {
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
                // Handle ItemList with job postings
                else if (data['@type'] === 'ItemList' && data.itemListElement) {
                    for (const listItem of data.itemListElement) {
                        const item = listItem.item || listItem;
                        if (item['@type'] === 'JobPosting') {
                            jobs.push(parseJobPosting(item));
                        }
                    }
                }
            } catch (parseErr) {
                log.debug(`Failed to parse JSON-LD: ${parseErr.message}`);
            }
        }

        if (jobs.length > 0) {
            log.info(`Extracted ${jobs.length} jobs via JSON-LD`);
        }

        return jobs;
    } catch (error) {
        log.warning(`JSON-LD extraction failed: ${error.message}`);
        return [];
    }
}

/**
 * Parse JobPosting schema to our format
 */
function parseJobPosting(jobData) {
    const hiringOrg = jobData.hiringOrganization || {};
    const jobLocation = jobData.jobLocation || {};
    const address = jobLocation.address || {};

    let location = '';
    if (typeof address === 'string') {
        location = address;
    } else {
        location = [
            address.addressLocality,
            address.addressRegion,
            address.addressCountry
        ].filter(Boolean).join(', ');
    }

    let salary = 'Not specified';
    if (jobData.baseSalary) {
        const baseSalary = jobData.baseSalary;
        if (baseSalary.value) {
            const value = baseSalary.value;
            if (typeof value === 'object') {
                salary = `${value.minValue || ''} - ${value.maxValue || ''} ${baseSalary.currency || ''}`.trim();
            } else {
                salary = `${value} ${baseSalary.currency || ''}`.trim();
            }
        }
    }

    return {
        jobTitle: jobData.title || '',
        company: hiringOrg.name || '',
        location: location,
        salary: salary,
        jobType: jobData.employmentType || 'Not specified',
        postedDate: jobData.datePosted || '',
        description: jobData.description ? stripHtml(jobData.description) : '',
        descriptionHtml: jobData.description || '',
        descriptionText: jobData.description ? stripHtml(jobData.description) : '',
        url: jobData.url || '',
        scrapedAt: new Date().toISOString()
    };
}

/**
 * Strip HTML tags from string
 */
function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract API endpoint calls from page network requests
 * Monitor XHR/Fetch requests to find the internal API
 */
async function extractJobsViaAPI(page) {
    log.info('Attempting to extract jobs via internal API');

    const capturedJobs = [];

    try {
        // Get all responses that might contain job data
        const responses = await page.evaluate(async () => {
            // Check for any embedded JSON data in the page
            const scripts = document.querySelectorAll('script:not([src])');
            const potentialData = [];

            scripts.forEach(script => {
                const content = script.textContent || '';
                // Look for job-related JSON objects
                if (content.includes('"jobs"') || content.includes('"listings"') ||
                    content.includes('"results"') || content.includes('jobData')) {
                    potentialData.push(content);
                }
            });

            return potentialData;
        });

        for (const content of responses) {
            try {
                // Try to extract JSON from script content
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const data = JSON.parse(jsonMatch[0]);
                    // Look for job arrays in common locations
                    const jobArray = data.jobs || data.listings || data.results ||
                        data.data?.jobs || data.data?.listings || [];

                    if (Array.isArray(jobArray) && jobArray.length > 0) {
                        log.info(`Found ${jobArray.length} jobs in embedded API data`);
                        for (const job of jobArray) {
                            capturedJobs.push({
                                jobTitle: job.title || job.jobTitle || job.name || '',
                                company: job.company || job.employer || job.hiringOrganization?.name || '',
                                location: job.location || job.city || '',
                                salary: job.salary || job.compensation || 'Not specified',
                                jobType: job.type || job.employmentType || 'Not specified',
                                postedDate: job.date || job.postedDate || job.datePosted || '',
                                description: job.description || job.snippet || '',
                                descriptionHtml: job.descriptionHtml || job.description || '',
                                descriptionText: stripHtml(job.description || ''),
                                url: job.url || job.link || '',
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            } catch (parseErr) {
                // Continue to next script
            }
        }

        return capturedJobs;

    } catch (error) {
        log.warning(`Failed to capture API data: ${error.message}`);
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
 * Extract job data from the page using Cheerio HTML parsing (Fallback method)
 */
async function extractJobDataViaHTML(page) {
    log.info('Extracting job data via HTML parsing with Cheerio');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];

        // Careerjet-specific selectors - multiple strategies
        const jobSelectors = [
            'article.job',
            '.job',
            '.cj-job',
            'li[data-url]',
            '.clicky',
            'article[data-url]',
            '.jobs-list article',
            '.job-card',
            '.job_result',
            '.result',
            '[class*="job"][class*="item"]',
            '[class*="job"][class*="card"]',
            '[class*="listing"]'
        ];

        let jobElements = $([]);

        for (const selector of jobSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                log.info(`Found ${elements.length} elements with selector: ${selector}`);
                jobElements = elements;
                break;
            }
        }

        if (jobElements.length === 0) {
            // Try a broader search - any element with job-related data attributes
            jobElements = $('[data-job], [data-job-id], [data-url*="job"]');
            if (jobElements.length > 0) {
                log.info(`Found ${jobElements.length} elements via data attributes`);
            }
        }

        jobElements.each((_, element) => {
            try {
                const $el = $(element);

                // Extract job title - try multiple patterns
                let jobTitle = '';
                const titleSelectors = ['h2 a', 'h3 a', '.title a', '.job-title a', 'a.job-title',
                    '[class*="title"] a', 'header a', '.header a', 'a:first'];
                for (const sel of titleSelectors) {
                    const titleEl = $el.find(sel).first();
                    if (titleEl.length && titleEl.text().trim()) {
                        jobTitle = titleEl.text().trim();
                        break;
                    }
                }

                // Extract URL
                let url = '';
                const urlSelectors = ['h2 a', 'h3 a', '.title a', 'a.job-title', '[class*="title"] a', 'a:first'];
                for (const sel of urlSelectors) {
                    const urlEl = $el.find(sel).first();
                    if (urlEl.length && urlEl.attr('href')) {
                        url = urlEl.attr('href');
                        if (url && !url.startsWith('http')) {
                            url = `https://www.careerjet.com${url}`;
                        }
                        break;
                    }
                }

                // Also check for data-url attribute
                if (!url) {
                    url = $el.attr('data-url') || '';
                    if (url && !url.startsWith('http')) {
                        url = `https://www.careerjet.com${url}`;
                    }
                }

                // Extract company
                let company = '';
                const companySelectors = ['.company', '.employer', '[class*="company"]',
                    '[class*="employer"]', 'p.company', '.job-company'];
                for (const sel of companySelectors) {
                    const compEl = $el.find(sel).first();
                    if (compEl.length && compEl.text().trim()) {
                        company = compEl.text().trim();
                        break;
                    }
                }

                // Extract location
                let location = '';
                const locationSelectors = ['.location', '.place', '[class*="location"]',
                    '[class*="place"]', '.job-location', 'ul.details li:first'];
                for (const sel of locationSelectors) {
                    const locEl = $el.find(sel).first();
                    if (locEl.length && locEl.text().trim()) {
                        location = locEl.text().trim();
                        break;
                    }
                }

                // Extract salary
                let salary = 'Not specified';
                const salarySelectors = ['.salary', '[class*="salary"]', '.pay', '[class*="pay"]'];
                for (const sel of salarySelectors) {
                    const salEl = $el.find(sel).first();
                    if (salEl.length && salEl.text().trim()) {
                        salary = salEl.text().trim();
                        break;
                    }
                }

                // Extract description/snippet
                let description = '';
                const descSelectors = ['.desc', '.description', '.snippet', '[class*="desc"]',
                    '[class*="snippet"]', 'p:not(.company):not(.location)'];
                for (const sel of descSelectors) {
                    const descEl = $el.find(sel).first();
                    if (descEl.length && descEl.text().trim()) {
                        description = descEl.text().trim();
                        break;
                    }
                }

                // Extract date
                let postedDate = '';
                const dateSelectors = ['.date', '.posted', '[class*="date"]', '[class*="time"]', 'time'];
                for (const sel of dateSelectors) {
                    const dateEl = $el.find(sel).first();
                    if (dateEl.length && dateEl.text().trim()) {
                        postedDate = dateEl.text().trim();
                        break;
                    }
                }

                // Only add if we have at least title or URL
                if (jobTitle || url) {
                    jobs.push({
                        jobTitle: jobTitle || 'Unknown Title',
                        company,
                        location,
                        salary,
                        jobType: 'Not specified',
                        postedDate,
                        description,
                        descriptionHtml: description,
                        descriptionText: description,
                        url,
                        scrapedAt: new Date().toISOString()
                    });
                }
            } catch (err) {
                log.debug(`Error extracting individual job: ${err.message}`);
            }
        });

        // If still no jobs, try extracting from anchor tags with job-like URLs
        if (jobs.length === 0) {
            log.info('Trying fallback: extracting from anchor tags');
            $('a[href*="/job/"], a[href*="jobdetail"], a[href*="/j/"]').each((_, el) => {
                const $a = $(el);
                const href = $a.attr('href');
                const text = $a.text().trim();

                if (text && text.length > 5 && !text.toLowerCase().includes('next') &&
                    !text.toLowerCase().includes('previous')) {
                    let fullUrl = href;
                    if (!fullUrl.startsWith('http')) {
                        fullUrl = `https://www.careerjet.com${href}`;
                    }

                    jobs.push({
                        jobTitle: text,
                        company: '',
                        location: '',
                        salary: 'Not specified',
                        jobType: 'Not specified',
                        postedDate: '',
                        description: '',
                        descriptionHtml: '',
                        descriptionText: '',
                        url: fullUrl,
                        scrapedAt: new Date().toISOString()
                    });
                }
            });
        }

        log.info(`Extracted ${jobs.length} jobs via HTML parsing`);
        return jobs;

    } catch (error) {
        log.warning(`HTML parsing failed: ${error.message}`);
        return [];
    }
}

/**
 * Debug: Save page HTML snippet for analysis when 0 jobs found
 */
async function saveDebugInfo(page) {
    try {
        const html = await page.content();
        const $ = cheerio.load(html);

        // Get body content sample (first 5000 chars)
        const bodySnippet = $('body').html()?.substring(0, 5000) || '';

        // Log some key elements for debugging
        const articleCount = $('article').length;
        const divJobCount = $('[class*="job"]').length;
        const listItemCount = $('li').length;

        log.warning('DEBUG: Page structure analysis', {
            articleCount,
            divJobCount,
            listItemCount,
            title: $('title').text(),
            hasCloudflare: html.includes('Just a moment') || html.includes('cf-browser')
        });

        // Save full HTML to key-value store for later analysis
        await Actor.setValue('DEBUG_PAGE_HTML', html, { contentType: 'text/html' });
        log.info('Saved full page HTML to DEBUG_PAGE_HTML for analysis');

    } catch (error) {
        log.warning(`Failed to save debug info: ${error.message}`);
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
    let extractionMethod = 'None';
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

                // Add a small delay to ensure dynamic content loads
                await page.waitForTimeout(2000);

                let jobs = [];

                // Strategy 1: Try JSON-LD extraction first (most reliable)
                jobs = await extractJobsViaJsonLD(page);
                if (jobs.length > 0) {
                    extractionMethod = 'JSON-LD';
                    log.info(`✓ JSON-LD extraction successful: ${jobs.length} jobs`);
                }

                // Strategy 2: Try internal API/embedded data if JSON-LD failed
                if (jobs.length === 0) {
                    jobs = await extractJobsViaAPI(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'Internal API';
                        log.info(`✓ Internal API extraction successful: ${jobs.length} jobs`);
                    }
                }

                // Strategy 3: Fall back to HTML parsing with Cheerio
                if (jobs.length === 0) {
                    jobs = await extractJobDataViaHTML(page);
                    if (jobs.length > 0) {
                        extractionMethod = 'HTML Parsing (Cheerio)';
                        log.info(`✓ HTML parsing successful: ${jobs.length} jobs`);
                    }
                }

                // If still no jobs, save debug info
                if (jobs.length === 0) {
                    log.warning('No jobs found with any extraction method. Saving debug info...');
                    await saveDebugInfo(page);
                }

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
                            document.querySelector('a[aria-label*="next" i]') ||
                            document.querySelector('a.page_next') ||
                            document.querySelector('.pager a.next');
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
        extractionMethod,
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
