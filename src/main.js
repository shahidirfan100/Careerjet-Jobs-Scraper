import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

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
 * Fetch complete job description from detail page using got-scraping
 * This is faster than using Playwright for each detail page
 * Uses cookies from Camoufox session to maintain Cloudflare bypass
 */
async function fetchFullDescription(jobUrl, cookies = '', userAgent = '') {
    try {
        const response = await gotScraping({
            url: jobUrl,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cookie': cookies,
                'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
            },
            timeout: { request: 15000 },
            retry: { limit: 1 },
        });

        // Check for Cloudflare block
        if (response.statusCode === 403 || response.statusCode === 503) {
            log.debug(`Cloudflare block detected on detail page (${response.statusCode}): ${jobUrl}`);
            return { blocked: true }; // Signal that session needs refresh
        }

        if (response.statusCode !== 200) {
            log.debug(`Detail page returned status ${response.statusCode}: ${jobUrl}`);
            return null;
        }

        const $ = cheerio.load(response.body);

        // Check if we got a Cloudflare challenge page
        const title = $('title').text();
        if (title.includes('Just a moment') || title.includes('Cloudflare')) {
            log.debug(`Cloudflare challenge page detected: ${jobUrl}`);
            return { blocked: true };
        }

        // Remove source/apply buttons and unwanted elements
        $('p.source, [data-source], .source, .apply-button, .actions, .notclicky').remove();

        // Try multiple selectors for job description on detail page
        const descriptionSelectors = [
            'section.content',
            '.job_description',
            '.job-description',
            '#job_description',
            '#job-description',
            'article .desc',
            '.job-content',
            '.job_content',
            'section.desc',
            'div.desc',
        ];

        let descriptionHtml = '';
        let descriptionText = '';

        for (const selector of descriptionSelectors) {
            const descEl = $(selector).clone();
            if (descEl.length && descEl.text().trim().length > 100) {
                // Remove source elements before extraction
                descEl.find('p.source, [data-source], .source').remove();

                // Remove "Related Jobs" section - find and remove everything after headings containing "related"
                descEl.find('h2, h3, h4').each((_, heading) => {
                    const $heading = $(heading);
                    const headingText = $heading.text().toLowerCase();
                    if (headingText.includes('related') || headingText.includes('similar')) {
                        // Remove this heading and all siblings after it
                        $heading.nextAll().remove();
                        $heading.remove();
                    }
                });

                descriptionHtml = descEl.html()?.trim() || '';
                descriptionText = descEl.text().trim();
                break;
            }
        }

        // If no description found with specific selectors, try the main content area
        if (!descriptionText) {
            const mainContent = $('main, article, .main-content, #main');
            if (mainContent.length) {
                // Remove navigation, header, footer, source elements
                mainContent.find('nav, header, footer, .sidebar, .related-jobs, p.source, [data-source]').remove();
                descriptionHtml = mainContent.html()?.trim() || '';
                descriptionText = mainContent.text().trim();
            }
        }

        // Clean description - remove source paragraph pattern
        descriptionHtml = descriptionHtml.replace(/<p[^>]*class="source"[^>]*>.*?<\/p>/gi, '');
        descriptionHtml = descriptionHtml.replace(/<p[^>]*data-source[^>]*>.*?<\/p>/gi, '');

        // Also try to extract additional job details from detail page
        const jobType = $('[class*="job-type"], [class*="employment"], .job_type').first().text().trim() || '';

        if (descriptionText && descriptionText.length > 50) {
            return {
                descriptionHtml,
                descriptionText,
                jobType: jobType || null,
            };
        }

        return null;
    } catch (error) {
        // Check if error is related to blocking
        if (error.message && (error.message.includes('403') || error.message.includes('503'))) {
            log.debug(`Cloudflare block detected (error): ${jobUrl}`);
            return { blocked: true };
        }
        log.debug(`Failed to fetch detail page ${jobUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Enrich jobs with full descriptions from detail pages
 * Uses session cookies from Camoufox to maintain Cloudflare bypass
 */
async function enrichJobsWithFullDescriptions(jobs, page, maxConcurrency = 10) {
    if (jobs.length === 0) return jobs;

    log.info(`Fetching full descriptions for ${jobs.length} jobs...`);

    // Get cookies and user agent from current Camoufox session
    const cookies = await page.context().cookies();
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = await page.evaluate(() => navigator.userAgent);

    log.debug(`Using ${cookies.length} cookies from Camoufox session for detail pages`);

    // Process jobs in batches to avoid overwhelming the server
    const enrichedJobs = [];
    const batchSize = maxConcurrency;
    let blockedCount = 0;

    for (let i = 0; i < jobs.length; i += batchSize) {
        const batch = jobs.slice(i, i + batchSize);

        const batchPromises = batch.map(async (job) => {
            if (!job.url) return job;

            const fullDesc = await fetchFullDescription(job.url, cookieString, userAgent);

            // Check if we got blocked
            if (fullDesc && fullDesc.blocked) {
                blockedCount++;
                log.warning(`Detail page blocked by Cloudflare: ${job.url}`);
                // Return job with original snippet - don't fail the entire batch
                return job;
            }

            if (fullDesc && fullDesc.descriptionHtml) {
                return {
                    ...job,
                    descriptionHtml: fullDesc.descriptionHtml,
                    descriptionText: fullDesc.descriptionText,
                    jobType: fullDesc.jobType || job.jobType,
                };
            }

            return job;
        });

        const batchResults = await Promise.all(batchPromises);
        enrichedJobs.push(...batchResults);

        log.info(`Enriched ${Math.min(i + batchSize, jobs.length)}/${jobs.length} jobs with full descriptions`);

        // Small delay between batches - reduced for speed
        if (i + batchSize < jobs.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    if (blockedCount > 0) {
        log.warning(`${blockedCount} detail pages were blocked by Cloudflare - using snippets instead`);
    }

    return enrichedJobs;
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
 * Extract job data from the page using Cheerio HTML parsing (Primary method with exact selectors)
 */
async function extractJobDataViaHTML(page) {
    log.info('Extracting job data via HTML parsing with Cheerio');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];

        // Exact Careerjet selector - article.job.clicky
        const jobElements = $('article.job.clicky');

        log.info(`Found ${jobElements.length} job cards with selector: article.job.clicky`);

        if (jobElements.length === 0) {
            // Fallback selectors if primary fails
            const fallbackSelectors = ['article.job', '.job.clicky', 'article[class*="job"]'];
            for (const selector of fallbackSelectors) {
                const elements = $(selector);
                if (elements.length > 0) {
                    log.info(`Fallback: Found ${elements.length} elements with selector: ${selector}`);
                    elements.each((_, element) => {
                        const job = extractJobFromElement($, $(element));
                        if (job) jobs.push(job);
                    });
                    break;
                }
            }
        } else {
            jobElements.each((_, element) => {
                const job = extractJobFromElement($, $(element));
                if (job) jobs.push(job);
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
 * Extract job data from a single job element using exact Careerjet selectors
 */
function extractJobFromElement($, $el) {
    try {
        // Job Title - from header > a
        const headerEl = $el.find('header a').first();
        const jobTitle = headerEl.text().trim() || '';

        // Job URL - from header > a href
        let url = headerEl.attr('href') || '';
        if (url && !url.startsWith('http')) {
            url = `https://www.careerjet.com${url}`;
        }

        // Company - from p.company (may contain a link)
        const companyEl = $el.find('p.company');
        let company = companyEl.find('a.notclicky').text().trim() || companyEl.text().trim() || '';

        // Location - from ul.location
        const location = $el.find('ul.location').text().trim() || '';

        // Salary - from ul.salary
        const salary = $el.find('ul.salary').text().trim() || 'Not specified';

        // Snippet from listing page - remove source elements
        const descEl = $el.find('.desc').clone();
        descEl.find('p.source, [data-source], .source').remove();
        const snippet = descEl.text().trim() || '';
        let snippetHtml = descEl.html()?.trim() || '';
        // Remove source tag from HTML
        snippetHtml = snippetHtml.replace(/<p[^>]*class="source"[^>]*>.*?<\/p>/gi, '');
        snippetHtml = snippetHtml.replace(/<p[^>]*data-source[^>]*>.*?<\/p>/gi, '');

        // Posted date - extract only the date text from footer
        // Footer contains: "13 hours ago Apply easily" - we only want the date part
        const footerText = $el.find('footer').text().trim() || '';
        // Extract date pattern (e.g., "13 hours ago", "2 days ago", "Just now")
        const dateMatch = footerText.match(/^([\d\w\s]+(?:ago|now|today|yesterday))/i);
        const postedDate = dateMatch ? dateMatch[1].trim() : footerText.split('Apply')[0].trim();

        // Only add if we have at least title or URL
        if (jobTitle || url) {
            return {
                jobTitle: jobTitle || 'Unknown Title',
                company,
                location,
                salary,
                jobType: 'Not specified',
                postedDate,
                // These will be populated with full description from detail page
                descriptionHtml: snippetHtml,
                descriptionText: snippet,
                url,
                scrapedAt: new Date().toISOString()
            };
        }
        return null;
    } catch (err) {
        log.debug(`Error extracting individual job: ${err.message}`);
        return null;
    }
}

/**
 * Legacy fallback extraction for non-standard pages
 */
async function extractJobDataViaHTMLFallback(page) {
    log.info('Trying fallback HTML extraction');

    try {
        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];

        // Try generic selectors
        const jobSelectors = [
            '.job',
            'li[data-url]',
            '.job-card',
            '.job_result',
            '[class*="job"][class*="item"]'
        ];

        let jobElements = $([]);

        for (const selector of jobSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                log.info(`Fallback found ${elements.length} elements with: ${selector}`);
                jobElements = elements;
                break;
            }
        }

        jobElements.each((_, element) => {
            try {
                const $el = $(element);

                // Extract job title - try multiple patterns
                let jobTitle = '';
                const titleSelectors = ['h2 a', 'h3 a', '.title a', '.job-title a', 'header a', 'a:first'];
                for (const sel of titleSelectors) {
                    const titleEl = $el.find(sel).first();
                    if (titleEl.length && titleEl.text().trim()) {
                        jobTitle = titleEl.text().trim();
                        break;
                    }
                }

                // Extract URL
                let url = '';
                const urlSelectors = ['h2 a', 'h3 a', '.title a', 'header a', 'a:first'];
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

                // Extract company
                let company = '';
                const companySelectors = ['.company', 'p.company', '[class*="company"]'];
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
    if (!input.searchUrl?.trim()) {
        // If no searchUrl, both searchQuery and location are required
        if (!input.searchQuery?.trim() || !input.location?.trim()) {
            throw new Error('Invalid input: Either provide a "searchUrl" OR both "searchQuery" and "location" are required');
        }
    }

    // Validate maxJobs range
    const maxJobs = input.maxJobs ?? 20; // Default to 20 for QA compliance
    if (maxJobs < 0 || maxJobs > 10000) {
        throw new Error('maxJobs must be between 0 and 10000');
    }

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

    // Deduplication - track seen job URLs
    const seenJobUrls = new Set();

    // Get proxy URL for Camoufox
    const proxyUrl = await proxyConfiguration.newUrl();

    // Create Playwright crawler with Camoufox for Cloudflare bypass
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 20, // Reduced for QA compliance - prevents runaway pagination
        maxConcurrency: 3, // Increased for faster scraping
        navigationTimeoutSecs: 30, // Reduced for speed
        requestHandlerTimeoutSecs: 120, // Reduced but enough for enrichment
        launchContext: {
            launcher: firefox,
            launchOptions: await camoufoxLaunchOptions({
                // Headless mode - must be boolean for Crawlee/Playwright
                headless: true,

                // Proxy configuration - use residential proxy for trusted IP
                proxy: proxyUrl,

                // GeoIP spoofing - matches location/timezone/locale to proxy IP
                // This is critical for Cloudflare bypass
                geoip: true,

                // OS fingerprint - Windows is most common and least suspicious
                os: 'windows',

                // Locale and language settings - match proxy location
                locale: 'en-US',

                // Screen constraints for realistic viewport
                // Avoid fixed sizes as they can be fingerprinted
                screen: {
                    minWidth: 1024,
                    maxWidth: 1920,
                    minHeight: 768,
                    maxHeight: 1080,
                },
            }),
        },

        async requestHandler({ page, request }) {
            pagesProcessed++;
            log.info(`Processing page ${pagesProcessed}: ${request.url}`);

            try {
                // Set realistic headers
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                });

                // Navigate to page - faster loading
                await page.goto(request.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                });

                // Wait for initial load - reduced timeout for speed
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

                // Check for Cloudflare challenge and handle it
                let cloudflareDetected = false;
                let retryCount = 0;
                const maxRetries = 3;

                while (retryCount < maxRetries) {
                    const title = await page.title();
                    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');

                    if (title.includes('Just a moment') ||
                        title.includes('Cloudflare') ||
                        bodyText.includes('unusual traffic') ||
                        bodyText.includes('Checking your browser')) {

                        cloudflareDetected = true;
                        log.warning(`Cloudflare challenge detected (attempt ${retryCount + 1}/${maxRetries})`);

                        // Wait for Cloudflare challenge to resolve
                        await page.waitForTimeout(3000);

                        // Try to click the Turnstile checkbox if present
                        try {
                            // Look for Turnstile iframe
                            const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
                            const checkbox = turnstileFrame.locator('input[type="checkbox"], .cf-turnstile-wrapper');

                            if (await checkbox.count() > 0) {
                                log.info('Found Turnstile checkbox, attempting click...');
                                await checkbox.first().click({ timeout: 5000 });
                                await page.waitForTimeout(3000);
                            }
                        } catch (clickErr) {
                            log.debug('No clickable Turnstile element found');
                        }

                        // Wait for page to potentially resolve
                        await page.waitForTimeout(5000);
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });

                        retryCount++;
                    } else {
                        // No Cloudflare detected, break out
                        if (cloudflareDetected) {
                            log.info('Cloudflare challenge bypassed successfully!');
                        }
                        break;
                    }
                }

                if (retryCount >= maxRetries) {
                    log.error('Failed to bypass Cloudflare after maximum retries');
                    await saveDebugInfo(page);
                    return;
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
                    let jobsToSave = maxJobs > 0
                        ? jobs.slice(0, Math.max(0, maxJobs - totalJobsScraped))
                        : jobs;

                    // Remove duplicates - filter out jobs we've already seen
                    const uniqueJobs = jobsToSave.filter(job => {
                        if (!job.url) return true; // Keep jobs without URL

                        if (seenJobUrls.has(job.url)) {
                            log.debug(`Skipping duplicate job: ${job.jobTitle} (${job.url})`);
                            return false;
                        }

                        seenJobUrls.add(job.url);
                        return true;
                    });

                    if (uniqueJobs.length < jobsToSave.length) {
                        log.info(`Removed ${jobsToSave.length - uniqueJobs.length} duplicate jobs`);
                    }

                    jobsToSave = uniqueJobs;

                    // Enrich jobs with full descriptions from detail pages
                    if (jobsToSave.length > 0) {
                        log.info('Enriching jobs with full descriptions from detail pages...');
                        jobsToSave = await enrichJobsWithFullDescriptions(jobsToSave, page);
                    }

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

                    // Look for next page - Careerjet uses p=2, p=3, etc.
                    // Build next URL by incrementing page parameter
                    const currentUrl = new URL(request.url);
                    const currentPage = parseInt(currentUrl.searchParams.get('p') || '1');

                    // Check if next button exists and is not disabled
                    const hasNextPage = await page.evaluate(() => {
                        const nextButton = document.querySelector('button.next') ||
                            document.querySelector('main p button.next');
                        return nextButton && !nextButton.disabled;
                    });

                    if (hasNextPage && totalJobsScraped < maxJobs) {
                        const nextPage = currentPage + 1;
                        currentUrl.searchParams.set('p', nextPage.toString());
                        const nextPageUrl = currentUrl.toString();

                        log.info(`Found next page: ${nextPageUrl} (page ${nextPage})`);

                        // Add the new URL to the queue
                        await crawler.addRequests([{
                            url: nextPageUrl,
                            uniqueKey: nextPageUrl
                        }]);
                    } else if (!hasNextPage) {
                        log.info('No next page button found - this may be the last page');
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

    log.info('✓ Scraping completed successfully!', statistics);

    if (totalJobsScraped > 0) {
        log.info(`Successfully scraped ${totalJobsScraped} jobs in ${duration} seconds`);
    } else {
        log.warning('No jobs were scraped. Please check your search parameters.');
    }

} catch (error) {
    log.exception(error, 'Actor failed with error');
    throw error;
}

// Exit successfully
await Actor.exit();
