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
    
    let totalPages = 0, currentPage = 1, pages = [], pdfDocument = null, extractedImages = [], rawTextContent = [];
    
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
            await extractTextContent();
            // Removed: await extractImages(pdfArrayBuffer);
            await generateBaseHTML();
            await enhanceWithLLM();
            hideLoader();
            finishConversion();
            
        } catch (error) {
            console.error('Error in hybrid processing:', error);
            hideLoader();
            showAlert(`Error: ${error.message}`, 'danger');
        }
    }
    
    async function extractTextContent() {
        rawTextContent = [];
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            try {
                const page = await pdfDocument.getPage(pageNum);
                const textContent = await page.getTextContent();
                const viewport = page.getViewport({ scale: 1.0 });
                
                const textStructure = {
                    pageNum,
                    blocks: [],
                    tables: [],
                    lists: [],
                    headings: []
                };
                
                // Process text items
                const allItems = textContent.items.map(item => ({
                    text: item.str || '',
                    x: item.transform[4],
                    y: item.transform[5],
                    width: item.width || 0,
                    height: item.height || 0,
                    fontSize: Math.abs(item.transform[0]) || 12,
                    fontName: item.fontName || 'default'
                })).filter(item => item.text.trim().length > 0);
                
                // Sort by position
                const sortedItems = allItems.sort((a, b) => {
                    const yDiff = Math.abs(b.y - a.y);
                    if (yDiff < Math.max(a.fontSize, b.fontSize) * 0.7) {
                        return a.x - b.x;
                    }
                    return b.y - a.y;
                });
                
                // Create blocks
                const blocks = createBlocks(sortedItems);
                textStructure.blocks = blocks;
                textStructure.tables = detectTables(blocks);
                textStructure.lists = detectLists(blocks);
                textStructure.headings = detectHeadings(blocks);
                
                rawTextContent.push(textStructure);
                
            } catch (error) {
                console.error(`Error extracting text from page ${pageNum}:`, error);
                rawTextContent.push({
                    pageNum,
                    blocks: [],
                    tables: [],
                    lists: [],
                    headings: []
                });
            }
        }
    }
    
    function createBlocks(sortedItems) {
        const blocks = [];
        let currentBlock = null;
        
        sortedItems.forEach(item => {
            const isNewBlock = !currentBlock || 
                               Math.abs(currentBlock.y - item.y) > 3 ||
                               Math.abs(currentBlock.fontSize - item.fontSize) > 2;
            
            if (isNewBlock) {
                if (currentBlock) {
                    blocks.push(currentBlock);
                }
                currentBlock = {
                    text: item.text,
                    x: item.x,
                    y: item.y,
                    fontSize: item.fontSize,
                    fontName: item.fontName
                };
            } else {
                currentBlock.text += ' ' + item.text;
            }
        });
        
        if (currentBlock) {
            blocks.push(currentBlock);
        }
        
        return blocks;
    }
    
    function detectTables(blocks) {
        return blocks.filter(block => 
            block.text.includes('\t') || /\s{3,}/.test(block.text)
        ).map(block => ({
            type: 'table',
            text: block.text,
            cells: block.text.split(/\t|\s{3,}/).filter(cell => cell.trim().length > 0)
        }));
    }
    
    function detectLists(blocks) {
        return blocks.filter(block => 
            /^[\d•\-\*\+]\s+/.test(block.text.trim())
        ).map(block => ({
            type: 'list',
            text: block.text,
            marker: block.text.match(/^[\d•\-\*\+]+/)?.[0] || ''
        }));
    }
    
    function detectHeadings(blocks) {
        const avgFontSize = blocks.reduce((sum, block) => sum + block.fontSize, 0) / blocks.length;
        
        return blocks.filter(block => 
            block.fontSize > avgFontSize * 1.2 ||
            block.fontName?.toLowerCase().includes('bold')
        ).map(block => ({
            ...block,
            type: 'heading',
            level: block.fontSize > avgFontSize * 1.8 ? 1 : 
                   block.fontSize > avgFontSize * 1.5 ? 2 : 3
        }));
    }
    
    async function generateBaseHTML() {
        for (let i = 0; i < totalPages; i++) {
            const textStructure = rawTextContent[i];
            
            let baseHTML = `<div class="pdf-page-content" data-page="${textStructure.pageNum}">`;
            
            // Add headings
            textStructure.headings.forEach(heading => {
                baseHTML += `<h${heading.level} class="pdf-heading">${escapeHtml(heading.text)}</h${heading.level}>`;
            });
            
            // Add tables
            textStructure.tables.forEach(table => {
                baseHTML += '<table class="table table-bordered">';
                baseHTML += '<tr>';
                table.cells.forEach(cell => {
                    baseHTML += `<td>${escapeHtml(cell.trim())}</td>`;
                });
                baseHTML += '</tr></table>';
            });
            
            // Add lists
            textStructure.lists.forEach(list => {
                baseHTML += `<ul><li>${escapeHtml(list.text)}</li></ul>`;
            });
            
            // Add regular text blocks
            textStructure.blocks.forEach(block => {
                if (!textStructure.headings.some(h => h.text === block.text) &&
                    !textStructure.tables.some(t => t.text === block.text) &&
                    !textStructure.lists.some(l => l.text === block.text)) {
                    baseHTML += `<p class="pdf-paragraph">${escapeHtml(block.text)}</p>`;
                }
            });
            
            baseHTML += '</div>';
            
            pages[i].content = baseHTML;
            pages[i].textStructure = textStructure;
        }
    }
    
    async function enhanceWithLLM() {
        for (let i = 0; i < totalPages; i++) {
            await enhancePageWithLLM(pages[i]);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
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
            
            // Generate content analysis report
            const contentAnalysis = {
                report: `
📈 CONTENT COMPLEXITY ANALYSIS:
   - Text Blocks: ${page.textStructure?.blocks?.length || 0}
   - Tables Detected: ${page.textStructure?.tables?.length || 0}
   - Lists Found: ${page.textStructure?.lists?.length || 0}
   - Headings: ${page.textStructure?.headings?.length || 0}
   - Graphics Present: YES

⚠️ SPECIAL ATTENTION NEEDED:
${page.textStructure?.tables?.length > 0 ? `- ${page.textStructure.tables.length} table(s) detected - ensure ALL rows and columns are captured` : ''}
${page.textStructure?.lists?.length > 0 ? `- ${page.textStructure.lists.length} list(s) found - preserve exact numbering and nesting` : ''}
- Graphics present - create detailed placeholders with descriptions
${page.textStructure?.blocks?.length > 15 ? '- Dense text content - use proper sectioning and hierarchy' : ''}
- Standard content extraction required`
            };
            
            // Comprehensive prompt for best output
            const prompt = `You are an expert PDF-to-HTML converter with perfect visual analysis skills.
**MISSION:**
Convert PDF page ${page.id} to HTML—**ZERO content loss**, PERFECT structure, **no overlaps**.
**EXTRACTION CHECKLIST:**
- **Text:** All content (headers, body, footnotes, captions, marginal/side text), exact formatting (bold, italic, underline, font), text hierarchy, relationships
- **Structure:** Tables (exact grid & borders), lists (nesting, bullets/numbering), headings (fonts/positions), columns/layout preserved
- **Visuals:** All graphics (charts/graphs/images/diagrams/icons/symbols) precisely positioned; add labeled placeholders if needed
- **Layout:** NO overlapping; use semantic HTML5; CSS Grid/Flexbox/absolute/z-index for complex/overlapping; maintain spacing/margins
- **Special:** Watermarks/backgrounds, form elements, footnotes, page numbers, headers/footers—**capture ALL**
**ANALYSIS INPUT:**
- Content analysis: ${contentAnalysis.report}
- Extracted structure: ${JSON.stringify(page.textStructure?.blocks)}
- Graphics detected: YES
- Original content (snippet): ${page.content}...
**HTML OUTPUT — USE THIS BOILERPLATE:**
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Page ${page.id} - Complete Content</title>
<style>
* {margin:0;padding:0;box-sizing:border-box;}
.page-container {position:relative;max-width:816px;margin:0 auto;background:#fff;padding:20px;line-height:1.4;}
.content-layer {position:relative;z-index:1;}
.positioned-element {position:absolute;z-index:2;}
.graphics-region {position:relative;border:2px dashed #ccc;background:#f9f9f9;min-height:100px;margin:10px 0;display:flex;align-items:center;justify-content:center;}
.pdf-table {border-collapse:collapse;width:100%;margin:15px 0;}
.pdf-table th, .pdf-table td {border:1px solid #ddd;padding:8px;text-align:left;}
.pdf-list {margin:10px 0;padding-left:20px;}
.pdf-heading {margin:15px 0 10px 0;font-weight:bold;}
.pdf-paragraph {margin:8px 0;}
@media (max-width:768px){.page-container{padding:10px;}.positioned-element{position:relative!important;}}
</style>
</head>
<body>
<div class="page-container">
  <div class="content-layer">
    <!-- FULLY reproduce all page content here with semantic HTML5; NO overlapping; ALL elements present/positioned -->
  </div>
</div>
</body>
</html>`;

            const messages = [
                {role: "user",content: [{type: "text",text: prompt},{type: "image_url",image_url: {url: pageImageBase64}
          }]}];
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
