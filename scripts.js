document.addEventListener('DOMContentLoaded', function() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    
    const els = {
        openaiKey: document.getElementById('openaiKey'),
        browseButton: document.getElementById('browseButton'),
        pdfUpload: document.getElementById('pdfUpload'),
        progressArea: document.getElementById('progressArea'),
        progressBar: document.getElementById('progressBar'),
        progressText: document.getElementById('progressText'),
        conversionStatus: document.getElementById('conversionStatus'),
        stageProgress: document.getElementById('stageProgress'),
        viewer: document.getElementById('viewer'),
        pageContent: document.getElementById('pageContent'),
        pageTitle: document.getElementById('pageTitle'),
        pageCounter: document.getElementById('pageCounter'),
        pageInput: document.getElementById('pageInput'),
        goToPage: document.getElementById('goToPage'),
        prevPage: document.getElementById('prevPage'),
        nextPage: document.getElementById('nextPage'),
    };
    
    let totalPages = 0, currentPage = 1, pages = [], pdfDocument = null;
    
    els.browseButton.onclick = () => els.pdfUpload.click();
    els.pdfUpload.onchange = (e) => {
        const file = e.target.files[0];
        if (file?.type === 'application/pdf') {
            processPDF(file, document.querySelector('input[name="strategy"]:checked').value);
        } else {
            showAlert('Please upload a PDF file.', 'danger');
        }
    };
    
    async function processPDF(file, strategy) {
        try {
            const fileReader = new FileReader();
            fileReader.onload = async function() {
                try {
                    const arrayBuffer = this.result;
                    pdfDocument = await pdfjsLib.getDocument(new Uint8Array(arrayBuffer)).promise;
                    totalPages = pdfDocument.numPages;
                    pages = Array.from({length: totalPages}, (_, i) => ({
                        id: i + 1, title: `Page ${i + 1}`, content: '', processed: false
                    }));
                    await processHybridStrategy(arrayBuffer);
                } catch (error) {
                    hideLoader();
                    showAlert(`Error: ${error.message}`, 'danger');
                }
            };
            fileReader.readAsArrayBuffer(file);
        } catch (error) {
            hideLoader();
            showAlert(`Error: ${error.message}`, 'danger');
        }
    }
    
    async function processHybridStrategy(pdfArrayBuffer) {
        showLoader('Processing PDF...');
        try {
            await enhanceWithLLM();
            hideLoader();
            finishConversion();
            
        } catch (error) {
            console.error('Error in hybrid processing:', error);
            hideLoader();
            showAlert(`Error: ${error.message}`, 'danger');
        }
    }
    
    
    async function enhanceWithLLM() {
        const BATCH_SIZE = 3;
        const batches = [];
        
        // Create batches of 3 pages
        for (let i = 0; i < totalPages; i += BATCH_SIZE) {
            batches.push(pages.slice(i, i + BATCH_SIZE));
        }
        
        updateProgress(55, `Processing all ${batches.length} batches concurrently (${totalPages} pages total)`);
        
        // Process ALL batches concurrently
        const allBatchPromises = batches.map((batch, batchIndex) => {
            // Process all pages in each batch concurrently
            const batchPromises = batch.map(page => enhancePageWithLLM(page));
            return Promise.all(batchPromises);
        });
        
        // Wait for all batches to complete
        await Promise.all(allBatchPromises);
        
        updateProgress(95, `All ${totalPages} pages processed successfully`);
    }
    
    async function enhancePageWithLLM(page) {
        try {
            const apiKey = els.openaiKey.value.trim();
            if (!apiKey) {
                throw new Error('OpenAI API key is required');
            }
            
            // Minimal base64 conversion
            const pdfPage = await pdfDocument.getPage(page.id);
            const viewport = pdfPage.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await pdfPage.render({ canvasContext: context, viewport: viewport }).promise;
            const pageImageBase64 = canvas.toDataURL('image/jpeg', 0.9);
            
            // Extract hyperlinks
            const annotations = await pdfPage.getAnnotations();
            const links = annotations.filter(ann => ann.subtype === 'Link').map(link => ({
                url: link.url || link.dest,
                rect: link.rect,
                text: link.contents || 'Link'
            }));
            
        // System prompt with general instructions
        const systemPrompt = `You are a PDF-to-HTML converter with expertise in visual analysis and Bootstrap icons.

**Bootstrap Icon Integration:**
- Select appropriate Bootstrap icons for all symbols.

**Layout & Positioning:**
- Preserve spatial relationships and orientations.
- Use CSS to prevent overlap and ensure contrast.

**Size & Scale:**
- Maintain element sizes, font relationships, and spacing.

**Extraction Checklist:**
- Extract text, structure, icons, and layout accurately.
- Use semantic HTML5 and Bootstrap icons.

**HTML Template:**
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>[Page Title]</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.0/font/bootstrap-icons.css" rel="stylesheet">
<style>
/* Styles for size, spacing, and layout */
</style>
</head>
<body>
<div class="page-container">
  <div class="background-layer"></div>
  <div class="content-layer"></div>
</div>
</body>
</html>

**Critical Requirements:**
1. Match PDF sizes with .text-* classes.
2. Maintain dimensions with .w-* and .min-h-* classes.
3. Use spacing classes for margins and padding.
4. Prevent overlap with CSS layout techniques.
5. Preserve layout orientation.
6. Ensure text contrast.
7. Use z-index for layering.
8. Use .chart-container and .image-* for sizing.
9. Maintain responsiveness with layout classes.
10. Replace icons with Bootstrap icons.`;

            // User prompt with specific page data
            const userPrompt = `**Mission:**
Convert PDF page ${page.id} to HTML with no content loss, exact sizing, and Bootstrap icon integration.

**Size Preservation:**
- Match PDF font sizes with .text-* classes.
- Use .w-* and .min-h-* for dimensions.
- Replicate spacing with .spacing-* classes.

**Hyperlinks:**
${links.length > 0 ? links.map(link => `- URL: ${link.url} (Position: ${link.rect})`).join('\n') : 'No hyperlinks found.'}

**Hyperlink Integration:**
- Convert hyperlinks to <a> tags with href and target='_blank'.
- Maintain styling and positioning with Bootstrap classes.

Analyze the PDF page image and convert it to HTML, following system instructions and focusing on this page's content.`;

            const messages = [
                {role: "system", content: systemPrompt},
                {role: "user", content: [
                    {type: "text", text: userPrompt},
                    {type: "image_url", image_url: {url: pageImageBase64}}
                ]}
            ];
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: "anthropic/claude-sonnet-4",
                    messages: messages
                })
            });
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
            }
            
            const data = await response.json();
            let enhancedHTML = data.choices[0].message.content;
            
            // Clean up response
            enhancedHTML = cleanupLLMResponse(enhancedHTML);
            
            page.content = enhancedHTML;
            page.processed = true;
            
        } catch (error) {
            console.error(`Error enhancing page ${page.id}:`, error);
            // Keep original content as fallback
            page.processed = true;
        }
    }
    
    function cleanupLLMResponse(htmlContent) {
        // Remove code blocks
        if (htmlContent.includes("```html")) {
            htmlContent = htmlContent.split("```html")[1].split("```")[0].trim();
        } else if (htmlContent.includes("```")) {
            htmlContent = htmlContent.split("```")[1].split("```")[0].trim();
        }
        
        // Clean up entities
        htmlContent = htmlContent.replace(/&amp;/g, '&');
        htmlContent = htmlContent.replace(/&lt;/g, '<');
        htmlContent = htmlContent.replace(/&gt;/g, '>');
        
        return htmlContent.trim();
    }
    
    function updatePageDisplay() {
        const page = pages[currentPage - 1];
        els.pageTitle.textContent = page.title;
        els.pageContent.innerHTML = page.content;
        els.pageCounter.textContent = `Page ${currentPage} of ${totalPages}`;
        els.pageInput.value = '';
        
        els.prevPage.disabled = currentPage === 1;
        els.nextPage.disabled = currentPage === totalPages;
        
        els.pageContent.scrollTop = 0;
        window.scrollTo(0, els.viewer.offsetTop);
    }

    
    // Utility functions
    function showAlert(message, type = 'info') {
        const alertDiv = document.createElement('div');
        alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
        alertDiv.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
        document.querySelector('.card-body').prepend(alertDiv);
        setTimeout(() => {
            if (alertDiv.parentNode) {
                new bootstrap.Alert(alertDiv).close();
            }
        }, 5000);
    }
    
    function updateProgress(percent, message) {
        els.progressBar.style.width = `${percent}%`;
        els.progressText.textContent = `${Math.round(percent)}%`;
        els.conversionStatus.textContent = message;
    }
    
    function showLoader(message = 'Processing...') {
        els.progressArea.style.display = 'block';
        els.conversionStatus.textContent = message;
        els.progressBar.style.width = '100%';
        els.progressBar.classList.add('progress-bar-striped', 'progress-bar-animated');
        els.progressText.textContent = '';
        els.stageProgress.innerHTML = '';
    }
    
    function hideLoader() {
        els.progressArea.style.display = 'none';
        els.progressBar.classList.remove('progress-bar-striped', 'progress-bar-animated');
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    function finishConversion() {
        els.viewer.style.display = 'block';
        currentPage = 1;
        els.pageInput.max = totalPages;
        els.pageInput.placeholder = `1-${totalPages}`;
        updatePageDisplay();
    }
    
    // Navigation event handlers
    function navigatePage(direction) {
        if (direction === 'prev' && currentPage > 1) {
            currentPage--;
            updatePageDisplay();
        } else if (direction === 'next' && currentPage < totalPages) {
            currentPage++;
            updatePageDisplay();
        }
    }
    
    // Event listeners
    els.prevPage.onclick = () => navigatePage('prev');
    els.nextPage.onclick = () => navigatePage('next');
    
    els.goToPage.onclick = () => {
        const pageNum = parseInt(els.pageInput.value);
        if (pageNum >= 1 && pageNum <= totalPages) {
            currentPage = pageNum;
            updatePageDisplay();
        } else {
            els.pageInput.classList.add('is-invalid');
            setTimeout(() => els.pageInput.classList.remove('is-invalid'), 2000);
        }
    };
    
    els.pageInput.onkeyup = (e) => e.key === 'Enter' && els.goToPage.click();
});
