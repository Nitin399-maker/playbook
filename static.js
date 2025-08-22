export function displayStaticPage(page, elements, appState) {
    elements.staticContent.style.display = 'block';
    elements.treeContent.style.display = 'none';
    if (elements.exportHtmlBtn) {
        elements.exportHtmlBtn.style.display = 'inline-block';
    }
    const wrappedContent = `
        <div class="pdf-page-wrapper">
            ${page.content}
        </div>
    `;
    elements.pageContent.innerHTML = wrappedContent;
    elements.pageContent.scrollTop = 0;
    fixOverlappingElements(elements);
}

export async function processStaticPagesBatch(pages, appState) {
    const results = await convertPagesToHtmlBatch(pages, appState);
    pages.forEach((item, index) => {
        const pageIndex = item.pageNumber - 1;
        appState.pages[pageIndex].content = results[index];
        appState.pages[pageIndex].processed = true;
    });
}

export async function convertPagesToHtmlBatch(pages, appState) {
    try {
        const apiKey = document.getElementById('apiKey').value.trim();
        if (!apiKey) throw new Error('API key is required');
        const results = await Promise.all(pages.map(async (item) => {
            const pdfPage = await appState.pdfDocument.getPage(item.pageNumber);
            const annotations = await pdfPage.getAnnotations();
            const links = annotations.filter(ann => ann.subtype === 'Link')
                .map(link => ({ url: link.url || link.dest, rect: link.rect, text: link.contents || 'Link' }));
            
            const userPrompt = `**Mission:**
Convert PDF page ${item.pageNumber} to responsive HTML that fits in viewport WITHOUT overlapping or scrolling.

**CRITICAL REQUIREMENTS:**
- Use Bootstrap grid system (.container-fluid, .row, .col-*) for layout structure
- NO absolute positioning - use flow-based layout only
- Convert content to logical reading order: top to bottom, left to right
- Use Bootstrap typography classes (.fs-1 to .fs-6, .display-*, .lead, etc.)
- Ensure ALL content is visible without horizontal scrolling
- Prevent any element overlapping by using proper spacing (.mb-*, .mt-*, .p-*)

**Content Structure:**
- Group related content into Bootstrap cards, sections, or containers
- Use Bootstrap spacing utilities instead of exact pixel positioning
- Make diagrams and images responsive with .img-fluid class
- Organize multi-column content using Bootstrap grid columns

${links.length > 0 ? 'Hyperlinks found:\n' + links.map(link => `- URL: ${link.url} (Position: ${link.rect})`).join('\n') : 'No hyperlinks found.'}

Convert this page to clean, responsive HTML that preserves content meaning while ensuring everything fits properly within the viewport.`;
            
            const messages = [
                { role: "system", content: (await import('./utils.js')).staticSystemPrompt },
                { role: "user", content: [
                    { type: "text", text: userPrompt },
                    { type: "image_url", image_url: { url: item.imageData } }
                ]}
            ];
            return { pageNumber: item.pageNumber, messages };
        }));
        
        const responses = await Promise.all(results.map(async (result) => {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: "anthropic/claude-sonnet-4", messages: result.messages })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API error for page ${result.pageNumber}: ${errorData.error?.message || response.statusText}`);
            }  
            
            const data = await response.json();
            return cleanupHtml(data.choices[0].message.content);
        }));
        
        return responses;
    } catch (error) {
        console.error('Error in batch HTML conversion:', error);
        return pages.map(item => 
            `<div class="alert alert-danger">Error processing page ${item.pageNumber}: ${error.message}</div>`
        );
    }
}

export function exportHtml(pageNumber, appState) {
    const page = appState.pages[pageNumber - 1];
    if (page?.contentType !== 'static') return showAlert('Only static pages can be exported as HTML.', 'warning');
    
    const blob = new Blob([page.content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { 
        href: url, download: `page-${pageNumber}-content.html` 
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showAlert(`HTML content for page ${pageNumber} downloaded!`, 'success');
}

export function fixOverlappingElements(elements) {
    const absoluteElements = elements.pageContent.querySelectorAll('[style*="position: absolute"], .position-absolute');
    absoluteElements.forEach(el => {
        el.style.position = 'relative';
        el.style.display = 'block';
        el.style.marginBottom = '0.5rem';
        el.classList.remove('position-absolute');
        el.classList.add('d-block', 'mb-2');
    });
    
    const containers = elements.pageContent.querySelectorAll('div, section, article');
    containers.forEach(container => {
        container.style.maxWidth = '100%';
        container.style.wordWrap = 'break-word';
        container.style.overflowWrap = 'break-word';
    });
    
    const fixedWidthElements = elements.pageContent.querySelectorAll('[style*="width:"], [style*="min-width:"]');
    fixedWidthElements.forEach(el => {
        const style = el.style;
        if (style.width && style.width.includes('px')) {
            style.width = '100%';
            style.maxWidth = style.width.replace('width:', '');
        }
        if (style.minWidth && style.minWidth.includes('px')) {
            style.minWidth = 'auto';
        }
    });
}

export function cleanupHtml(htmlContent) {
    const match = htmlContent.match(/```(?:html)?\s*([\s\S]*?)\s*```/);
    htmlContent = match ? match[1].trim() : htmlContent;
    return htmlContent.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    document.querySelector('.card-body').prepend(alertDiv);
    setTimeout(() => {
        if (alertDiv.parentNode) {
            alertDiv.classList.remove('show');
            setTimeout(() => alertDiv.remove(), 150);
        }
    }, 5000);
} 