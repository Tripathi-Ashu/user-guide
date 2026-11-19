const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// =====================================================================
// 1. CONFIGURATION (read + validate)
// =====================================================================

const config = require("./config.json");

const START_URL = config.website.startUrl;
const auth = config.auth || { enabled: false };

// CRAWL_OUTPUT env variable can override the output folder from config.json
const OUTPUT_FOLDER = path.resolve(
    __dirname,
    process.env.CRAWL_OUTPUT || config.output.folder
);
const PAGES_FOLDER = path.join(OUTPUT_FOLDER, "pages");

// URLs containing any of these patterns are never visited (logout protection)
const EXCLUDE_PATTERNS = (config.crawler.excludeUrlPatterns || [])
    .map(pattern => pattern.toLowerCase());

function isExcludedUrl(parsedUrl) {
    const fullPath = (parsedUrl.pathname + parsedUrl.search).toLowerCase();
    return EXCLUDE_PATTERNS.some(pattern => fullPath.includes(pattern));
}

// --- Validate website settings ---
if (!START_URL) {
    throw new Error("Invalid website URL in config.json");
}

const parsedStartUrl = new URL(START_URL);

if (!["http:", "https:"].includes(parsedStartUrl.protocol)) {
    throw new Error("startUrl must use HTTP or HTTPS");
}

// --- Validate crawler settings ---
if (!["domcontentloaded", "load", "networkidle", "commit"].includes(config.crawler.waitUntil)) {
    throw new Error("Invalid waitUntil value in config.json");
}

if (typeof config.crawler.loadingSelector !== "string" || !config.crawler.loadingSelector.trim()) {
    throw new Error("crawler.loadingSelector must be a non-empty CSS selector in config.json");
}

// --- Validate auth settings ---
if (typeof auth.enabled !== "boolean") {
    throw new Error("auth.enabled must be true or false in config.json");
}

if (auth.enabled) {
    const requiredAuthSettings = [
        auth.loginUrl,
        auth.usernameSelector,
        auth.passwordSelector,
        auth.submitSelector
    ];

    if (requiredAuthSettings.some(value => typeof value !== "string" || !value.trim())) {
        throw new Error("All auth login settings must be configured when auth.enabled is true");
    }

    if (
        !(typeof auth.successUrl === "string" && auth.successUrl.trim()) &&
        !(typeof auth.successSelector === "string" && auth.successSelector.trim())
    ) {
        throw new Error("Configure auth.successUrl or auth.successSelector when auth.enabled is true");
    }

    const parsedLoginUrl = new URL(auth.loginUrl);
    if (!["http:", "https:"].includes(parsedLoginUrl.protocol)) {
        throw new Error("auth.loginUrl must use HTTP or HTTPS");
    }

    if (auth.successUrl) {
        // "/**" glob suffix is converted so it can be parsed as a URL
        const successUrl = auth.successUrl.replace(/\/\*\*$/, "/");
        const parsedSuccessUrl = new URL(successUrl);
        if (!["http:", "https:"].includes(parsedSuccessUrl.protocol)) {
            throw new Error("auth.successUrl must use HTTP or HTTPS");
        }
    }

    // Credentials come from environment variables, never from the config file
    if (!process.env.CRAWLER_USERNAME || !process.env.CRAWLER_PASSWORD) {
        throw new Error("Set CRAWLER_USERNAME and CRAWLER_PASSWORD environment variables when auth.enabled is true");
    }
}

// =====================================================================
// 2. CRAWLER STORAGE
// =====================================================================

const visitedUrls = new Set();     // pages already seen (prevents repeats)
const urlQueue = [START_URL];      // pages waiting to be crawled (FIFO)

const websiteData = {              // summary written to crawl-summary.json
    websiteName: config.website.name,
    website: START_URL,
    crawledAt: new Date().toISOString(),
    totalPages: 0,
    failedPages: [],
    pages: []
};

// =====================================================================
// 3. GENERATE READABLE FOLDER NAMES
// =====================================================================

function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")   // anything unsafe becomes a dash
        .replace(/^-+|-+$/g, "")       // trim leading/trailing dashes
        .substring(0, 80);
}

function generateFolderName(pageData, pageNumber) {
    const url = new URL(pageData.pageUrl);

    // Prefer URL path, then page title, then "home"
    let pageName = slugify(url.pathname);
    if (!pageName) {
        pageName = slugify(pageData.pageTitle) || "home";
    }

    const number = String(pageNumber).padStart(2, "0");
    return `${number}-${pageName}`;     // e.g. 01-about-us
}

// =====================================================================
// 4. NORMALIZE WEBSITE URLS
// =====================================================================

function normalizeUrl(url) {
    try {
        const parsedUrl = new URL(url);

        // Allow only HTTP and HTTPS
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
            return null;
        }

        // Restrict crawling to the starting domain if enabled
        if (
            config.crawler.sameDomainOnly &&
            parsedUrl.hostname !== parsedStartUrl.hostname
        ) {
            return null;
        }

        // Never visit logout URLs (checked BEFORE the query string is removed)
        if (isExcludedUrl(parsedUrl)) {
            return null;
        }

        // Remove URL fragments (#section)
        parsedUrl.hash = "";

        // Remove query parameters if configured
        if (config.crawler.removeQueryParameters) {
            parsedUrl.search = "";
        }

        // Remove trailing slash except for the homepage
        if (parsedUrl.pathname !== "/") {
            parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
        }

        return parsedUrl.href;
    } catch (error) {
        return null;
    }
}

// =====================================================================
// 5. EXTRACT WEBPAGE INFORMATION (runs inside the browser)
// =====================================================================

async function extractPageData(page) {
    return await page.evaluate(() => {

        // Select elements, ignoring anything inside a footer
        const getElements = (selector, root = document) =>
            Array.from(root.querySelectorAll(selector))
                .filter(element => !element.closest("footer, [role='contentinfo']"));

        // Visible text of an element, without footer content
        const getContentText = (element) => {
            const content = element.cloneNode(true);
            content.querySelectorAll("footer, [role='contentinfo']")
                .forEach(el => el.remove());

            // innerText only works on rendered elements, so attach off-screen
            const container = document.createElement("div");
            container.style.position = "fixed";
            container.style.left = "-10000px";
            container.appendChild(content);
            document.body.appendChild(container);
            const text = content.innerText.trim();
            container.remove();
            return text;
        };

        // Text of all elements matching a selector
        const getText = (selector) =>
            getElements(selector)
                .map(element => element.innerText.trim())
                .filter(Boolean);

        // Common attributes
        const getAttributes = (element) => ({
            id: element.id || "",
            className: typeof element.className === "string" ? element.className : "",
            ariaLabel: element.getAttribute("aria-label"),
            role: element.getAttribute("role")
        });

        return {

            // 1. Basic page information
            pageTitle: document.title,
            pageUrl: window.location.href,
            pageLanguage: document.documentElement.lang || "",
            pageCharset: document.characterSet,
            pageDescription: document.body ? getContentText(document.body) : "",
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight
            },

            // 2. SEO information
            seo: {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content || "",
                keywords: document.querySelector('meta[name="keywords"]')?.content || "",
                author: document.querySelector('meta[name="author"]')?.content || "",
                canonical: document.querySelector('link[rel="canonical"]')?.href || "",
                robots: document.querySelector('meta[name="robots"]')?.content || "",
                openGraph: Array.from(document.querySelectorAll('meta[property^="og:"]'))
                    .map(meta => ({
                        property: meta.getAttribute("property"),
                        content: meta.content
                    })),
                twitter: Array.from(document.querySelectorAll('meta[name^="twitter:"]'))
                    .map(meta => ({
                        name: meta.name,
                        content: meta.content
                    }))
            },

            // 3. Headings
            headings: {
                h1: getText("h1"),
                h2: getText("h2"),
                h3: getText("h3"),
                h4: getText("h4"),
                h5: getText("h5"),
                h6: getText("h6")
            },

            // 4. Paragraphs
            paragraphs: getText("p"),

            // 5. Navigation
            navigation: getElements("nav").map(nav => ({
                text: getContentText(nav),
                links: getElements("a", nav).map(link => ({
                    text: link.innerText.trim(),
                    href: link.href,
                    ...getAttributes(link)
                }))
            })),

            // 6. Page sections
            sections: getElements(
                "main section, main article, body > section, body > article"
            ).map((section, index) => ({
                sectionNumber: index + 1,
                tag: section.tagName.toLowerCase(),
                heading: getElements("h1, h2, h3, h4, h5, h6", section)[0]?.innerText.trim() || "",
                text: getContentText(section),
                ...getAttributes(section)
            })),

            // 7. Links
            links: getElements("a").map(link => ({
                text: link.innerText.trim(),
                href: link.href,
                target: link.target,
                title: link.title,
                ...getAttributes(link)
            })),

            // 8. Clickable elements
            clickableElements: getElements(
                "button, [role='button'], [onclick], input[type='button'], input[type='submit']"
            ).map(element => ({
                tag: element.tagName.toLowerCase(),
                text: element.innerText?.trim() || element.value || "",
                type: element.type || "",
                title: element.title || "",
                ...getAttributes(element)
            })),

            // 9. Forms
            forms: getElements("form").map((form, index) => ({
                formNumber: index + 1,
                action: form.action,
                method: form.method,
                fields: getElements("input, textarea, select, button", form).map(field => ({
                    tag: field.tagName.toLowerCase(),
                    type: field.type || "",
                    name: field.name || "",
                    id: field.id || "",
                    placeholder: field.placeholder || "",
                    required: field.required,
                    // Do not store password values
                    value: field.type === "password" ? "" : field.value || "",
                    ...getAttributes(field)
                }))
            })),

            // 10. Input elements
            inputs: getElements("input, textarea, select").map(input => ({
                tag: input.tagName.toLowerCase(),
                type: input.type || "",
                name: input.name || "",
                id: input.id || "",
                placeholder: input.placeholder || "",
                required: input.required,
                ...getAttributes(input)
            })),

            // 11. Images
            images: getElements("img").map(image => ({
                src: image.src,
                alt: image.alt || "",
                title: image.title || "",
                width: image.naturalWidth,
                height: image.naturalHeight,
                loading: image.loading
            })),

            // 12. Tables
            tables: getElements("table").map((table, index) => ({
                tableNumber: index + 1,
                headers: getElements("thead th", table).map(th => th.innerText.trim()),
                rows: getElements("tbody tr", table).map(row =>
                    getElements("th, td", row).map(cell => cell.innerText.trim())
                )
            })),

            // 14. Accessibility
            accessibility: {
                landmarks: getElements("header, nav, main, aside, [role]").map(element => ({
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role"),
                    ariaLabel: element.getAttribute("aria-label")
                })),
                elementsWithoutAlt: getElements("img:not([alt])").length,
                buttonsWithoutLabel: getElements("button").filter(button =>
                    !button.innerText.trim() && !button.getAttribute("aria-label")
                ).length
            },

            // 15. Structured data (JSON-LD)
            structuredData: getElements('script[type="application/ld+json"]').map(script => {
                try {
                    return JSON.parse(script.textContent);
                } catch {
                    return script.textContent;
                }
            })
        };
    });
}

// =====================================================================
// 6. LOGIN (only when auth.enabled is true)
// =====================================================================

// Opens a URL, retrying only on temporary network errors
// (e.g. ERR_INTERNET_DISCONNECTED, VPN/Wi-Fi drops, DNS hiccups)
async function gotoWithRetry(page, url) {
    const attempts = config.crawler.navigationRetries ?? 3;
    const networkError = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT/i;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await page.goto(url, {
                waitUntil: config.crawler.waitUntil,
                timeout: config.crawler.timeout
            });
        } catch (error) {
            lastError = error;
            if (!networkError.test(error.message) || attempt === attempts) {
                break;
            }
            const waitMs = 5000 * attempt;
            console.warn(`Network error on attempt ${attempt}/${attempts} for ${url}. Retrying in ${waitMs / 1000}s...`);
            await page.waitForTimeout(waitMs);
        }
    }
    throw lastError;
}

async function loginIfEnabled(page) {
    if (!auth.enabled) {
        return;
    }

    // Open the login page
    const response = await gotoWithRetry(page, auth.loginUrl);

    if (!response || response.status() >= 400) {
        throw new Error("Unable to load the configured login page");
    }

    // Fill credentials from environment variables
    await page.locator(auth.usernameSelector).fill(process.env.CRAWLER_USERNAME);
    await page.locator(auth.passwordSelector).fill(process.env.CRAWLER_PASSWORD);

    // Success = URL matches, or a success element becomes visible
    let loginSuccess;
    if (auth.successUrl) {
        loginSuccess = page.waitForURL(auth.successUrl, {
            timeout: config.crawler.timeout
        });
    } else {
        loginSuccess = page.locator(auth.successSelector).waitFor({
            state: "visible",
            timeout: config.crawler.timeout
        });
    }

    // Start waiting for success and click submit at the same time
    await Promise.all([
        loginSuccess,
        page.locator(auth.submitSelector).click()
    ]);
}

// =====================================================================
// 7. MAIN CRAWL LOOP (breadth-first, one page at a time)
// =====================================================================

async function crawlPages(page) {
    while (urlQueue.length > 0) {

        const currentUrl = urlQueue.shift();
        const normalizedUrl = normalizeUrl(currentUrl);

        // Skip invalid, excluded (logout) or already visited URLs
        if (!normalizedUrl || visitedUrls.has(normalizedUrl)) {
            continue;
        }

        visitedUrls.add(normalizedUrl);
        console.log("Crawling:", normalizedUrl);

        try {
            // --- Open the page ---
            const response = await gotoWithRetry(page, normalizedUrl);

            // Ensure the document and its resources are fully loaded
            await page.waitForLoadState("load", {
                timeout: config.crawler.timeout
            });

            // Wait (up to loadingTimeout) for loading indicators to disappear.
            // If something never disappears, we do NOT fail the page: we log
            // exactly which element is stuck and continue with the capture.
            let loadingWarning = null;
            try {
                await page.waitForFunction((selector) => {
                    return Array.from(document.querySelectorAll(selector)).every(element => {
                        const style = window.getComputedStyle(element);
                        const rect = element.getBoundingClientRect();
                        return style.display === "none" ||
                            style.visibility === "hidden" ||
                            style.opacity === "0" ||
                            rect.width === 0 ||
                            rect.height === 0;
                    });
                }, config.crawler.loadingSelector, {
                    timeout: config.crawler.loadingTimeout || 15000
                });
            } catch (error) {
                if (error.name !== "TimeoutError") {
                    throw error;
                }

                // Find out which elements are still "loading"
                const stuck = await page.evaluate((selector) => {
                    return Array.from(document.querySelectorAll(selector))
                        .filter(element => {
                            const style = window.getComputedStyle(element);
                            const rect = element.getBoundingClientRect();
                            return !(style.display === "none" ||
                                style.visibility === "hidden" ||
                                style.opacity === "0" ||
                                rect.width === 0 ||
                                rect.height === 0);
                        })
                        .slice(0, 5)
                        .map(element => element.outerHTML.substring(0, 200));
                }, config.crawler.loadingSelector);

                loadingWarning = {
                    message: "Loading indicators were still visible after loadingTimeout; page captured anyway",
                    stillVisible: stuck
                };

                console.warn("Loading indicator still visible on", normalizedUrl);
                stuck.forEach(html => console.warn("   ->", html));
            }

            // Extra wait for dynamic content
            await page.waitForTimeout(config.crawler.waitTime);

            // --- Check the HTTP response ---
            if (!response || response.status() >= 400) {
                console.warn(
                    "Skipping page with unsuccessful response:",
                    normalizedUrl,
                    response ? response.status() : "no response"
                );

                websiteData.failedPages.push({
                    url: normalizedUrl,
                    status: response ? response.status() : null,
                    error: "Page returned an unsuccessful response"
                });
                continue;
            }

            // --- Check where the browser actually ended up (redirects) ---
            const finalUrl = new URL(page.url());

            if (
                config.crawler.sameDomainOnly &&
                finalUrl.hostname !== parsedStartUrl.hostname
            ) {
                console.warn(
                    "Skipping page redirected outside the allowed domain:",
                    normalizedUrl
                );

                websiteData.failedPages.push({
                    url: normalizedUrl,
                    status: response.status(),
                    error: "Page redirected outside the allowed domain and was skipped"
                });
                continue;
            }

            // Safety net: a page redirected to a logout URL
            if (isExcludedUrl(finalUrl)) {
                console.warn(
                    "Skipping page that redirected to an excluded (logout) URL:",
                    normalizedUrl
                );

                websiteData.failedPages.push({
                    url: normalizedUrl,
                    status: response.status(),
                    error: "Page redirected to an excluded URL and was skipped"
                });
                continue;
            }

            // --- Extract page data ---
            const pageData = await extractPageData(page);
            pageData.httpStatus = response.status();
            pageData.crawledAt = new Date().toISOString();
            pageData.loadingWarning = loadingWarning;

            // --- Create the numbered page folder ---
            const pageNumber = websiteData.pages.length + 1;
            const folderName = generateFolderName(pageData, pageNumber);
            const pageFolder = path.join(PAGES_FOLDER, folderName);

            if (config.output.saveIndividualJson || config.output.saveScreenshots) {
                fs.mkdirSync(pageFolder, { recursive: true });
            }

            // --- Screenshot ---
            let screenshotRelativePath = null;

            if (config.output.saveScreenshots) {
                const screenshotPath = path.join(pageFolder, "screenshot.png");

                try {
                    await page.screenshot({
                        path: screenshotPath,
                        fullPage: config.output.fullPageScreenshot,
                        animations: "disabled"
                    });

                    pageData.screenshot = "screenshot.png";
                    screenshotRelativePath = `pages/${folderName}/screenshot.png`;
                    console.log("Screenshot saved:", folderName);

                } catch (screenshotError) {
                    pageData.screenshot = null;
                    pageData.screenshotError = screenshotError.message;
                }
            } else {
                pageData.screenshot = null;
            }

            // --- Save individual page JSON ---
            let jsonRelativePath = null;

            if (config.output.saveIndividualJson) {
                const jsonPath = path.join(pageFolder, "page.json");
                fs.writeFileSync(jsonPath, JSON.stringify(pageData, null, 2), "utf8");
                jsonRelativePath = `pages/${folderName}/page.json`;
            }

            // --- Add the page to the summary ---
            websiteData.pages.push({
                pageNumber,
                pageTitle: pageData.pageTitle,
                pageUrl: pageData.pageUrl,
                httpStatus: pageData.httpStatus,
                folder: folderName,
                json: jsonRelativePath,
                screenshot: screenshotRelativePath
            });

            websiteData.totalPages = websiteData.pages.length;
            console.log("Completed:", pageData.pageTitle);

            // --- Discover internal links and queue new ones ---
            for (const link of pageData.links) {
                const discoveredUrl = normalizeUrl(link.href);

                if (
                    discoveredUrl &&
                    !visitedUrls.has(discoveredUrl) &&
                    !urlQueue.includes(discoveredUrl)
                ) {
                    urlQueue.push(discoveredUrl);
                }
            }

            // --- Delay between pages ---
            await page.waitForTimeout(config.crawler.delayBetweenPages);

        } catch (error) {
            // One failing page never stops the whole crawl
            console.error("Error crawling:", normalizedUrl, error.message);

            websiteData.failedPages.push({
                url: normalizedUrl,
                error: error.message
            });
        }
    }
}

// =====================================================================
// 8. FINISH (save summary + final report)
// =====================================================================

function finishCrawl() {

    // --- Save crawl summary ---
    if (config.output.saveSummary) {
        const summaryPath = path.join(OUTPUT_FOLDER, "crawl-summary.json");
        fs.writeFileSync(summaryPath, JSON.stringify(websiteData, null, 2), "utf8");
        console.log("Summary JSON:", summaryPath);
    }

    // --- Final report ---
    console.log("--------------------------------");
    console.log("Website crawling completed!");
    console.log("Website:", config.website.name);
    console.log("Total successful pages:", websiteData.totalPages);
    console.log("Failed pages:", websiteData.failedPages.length);
    console.log("Pages remaining in queue:", urlQueue.length);
    console.log("Output folder:", OUTPUT_FOLDER);
    console.log("--------------------------------");
}

// =====================================================================
// 9. EXECUTION (launch browser, run everything, always close browser)
// =====================================================================

async function crawlWebsite() {
    const browser = await chromium.launch({
        headless: config.browser.headless
    });

    const page = await browser.newPage({
        viewport: {
            width: config.browser.width,
            height: config.browser.height
        }
    });

    try {
        // Log in first (session cookies stay in this page's context)
        await loginIfEnabled(page);

        // Create output directories
        fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });

        if (config.output.saveIndividualJson || config.output.saveScreenshots) {
            fs.mkdirSync(PAGES_FOLDER, { recursive: true });
        }

        // Crawl every discoverable page
        await crawlPages(page);

        // Save summary and print report
        finishCrawl();

    } finally {
        await browser.close();
    }
}

crawlWebsite()
    .then(() => {
        console.log("Crawler finished successfully!");
    })
    .catch(error => {
        console.error("Crawler failed:", error);
        process.exitCode = 1;
    });
