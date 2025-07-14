import { staticSystemPrompt, decisionTreeSystemPrompt, classificationSystemPrompt, preschema, extractionPrompt} from './utils.js';
let appState = {
    pdfDocument: null, totalPages: 0, pages: [], currentPage: 1,
    processingQueue: [], currentlyProcessing: false, processedCount: 0,
    decisionTrees: {}, treeStates: {}, expandedSettings: false
};

const $ = id => document.getElementById(id);
const elements = {
    apiKey: $('apiKey'), toggleSettings: $('toggleSettings'),
    settingsPanel: $('settingsPanel'), staticPrompt: $('staticPrompt'), extractionPrompt: $('extractionPrompt'),schemaEditor: $('schemaEditor'), uploadArea: $('uploadArea'),
    pdfUpload: $('pdfUpload'), browseButton: $('browseButton'), progressArea: $('progressArea'),
    progressBar: $('progressBar'), progressText: $('progressText'), processingTitle: $('processingTitle'),
    processingStatus: $('processingStatus'), processingOverlay: $('processingOverlay'),
    overlayStatus: $('overlayStatus'), overlaySubstatus: $('overlaySubstatus'),
    overlayProgress: $('overlayProgress'), chunkPreview: $('chunkPreview'),
    contentViewer: $('contentViewer'), staticContent: $('staticContent'),
    pageTitle: $('pageTitle'), pageContent: $('pageContent'), pageCounter: $('pageCounter'),
    pageInput: $('pageInput'), goToPage: $('goToPage'), prevPage: $('prevPage'),
    nextPage: $('nextPage'), treeContent: $('treeContent'), treeVisualization: $('treeVisualization'),
    restartBtn: $('restartBtn'), exportJsonBtn: $('exportJsonBtn'),
    expandTreeBtn: $('expandTreeBtn'), collapseTreeBtn: $('collapseTreeBtn'),
    ...['step-1', 'step-2', 'step-3', 'step-4'].reduce((acc, id, i) => ({ ...acc, [`step${i+1}`]: $(id) }), {})
};

function init() {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    setupEventListeners();
    elements.schemaEditor.value = preschema;
    elements.extractionPrompt.value = extractionPrompt;
}

function setupEventListeners() {
    elements.toggleSettings.addEventListener('click', () => {
        elements.settingsPanel.classList.toggle('show');
        appState.expandedSettings = elements.settingsPanel.classList.contains('show');
    });
    elements.browseButton.addEventListener('click', () => elements.pdfUpload.click());
    elements.pdfUpload.addEventListener('change', handleFileSelection);
    elements.prevPage.addEventListener('click', () => navigatePage('prev'));
    elements.nextPage.addEventListener('click', () => navigatePage('next'));
    elements.goToPage.addEventListener('click', goToSpecificPage);
    elements.pageInput.addEventListener('keyup', e => e.key === 'Enter' && goToSpecificPage());
    elements.restartBtn.addEventListener('click', () => restartExploration(appState.currentPage));
    elements.exportJsonBtn.addEventListener('click', () => exportJson(appState.currentPage));
    elements.expandTreeBtn.addEventListener('click', expandTree);
    elements.collapseTreeBtn.addEventListener('click', collapseTree);
}

function handleFileSelection() {
    const file = elements.pdfUpload.files[0];
    if (file) {
        file.type === 'application/pdf' ? processPdf(file) : showAlert('Please select a PDF file.', 'danger');
    }
}

async function processPdf(file) {
    try {
        showProcessingOverlay('Loading PDF document...');
        updateProgressBar(5);
        updateProcessingStep(1);
        resetAppState();
        const fileArrayBuffer = await file.arrayBuffer();
        appState.pdfDocument = await pdfjsLib.getDocument(fileArrayBuffer).promise;
        appState.totalPages = appState.pdfDocument.numPages;
        updateOverlayStatus(`PDF loaded with ${appState.totalPages} pages. Analyzing content...`);
        updateProgressBar(10);
        appState.pages = Array.from({ length: appState.totalPages }, (_, i) => ({
            pageNumber: i + 1, title: `Page ${i + 1}`, contentType: null, processed: false, content: null
        }));
        await analyzeAndQueuePages();
        processNextInQueue();   
    } catch (error) {
        hideProcessingOverlay();
        showAlert(`Error processing PDF: ${error.message}`, 'danger');
    }
}

function resetAppState() {
    Object.assign(appState, {
        pdfDocument: null, totalPages: 0, pages: [], currentPage: 1,
        processingQueue: [], currentlyProcessing: false, processedCount: 0,
        decisionTrees: {}, treeStates: {}
    });
}

async function analyzeAndQueuePages() {
    updateProcessingStep(2);
    updateOverlayStatus('Analyzing page content types...');
    const BATCH_SIZE = appState.totalPages > 10 ? 10 : 3;
    const totalBatches = Math.ceil(appState.totalPages / BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * BATCH_SIZE;
        const batchEnd = Math.min((batchIndex + 1) * BATCH_SIZE, appState.totalPages);
        const batchPages = [];
        updateOverlaySubstatus(`Analyzing batch ${batchIndex + 1}/${totalBatches} (pages ${batchStart + 1}-${batchEnd}) - Batch size: ${BATCH_SIZE}`);
        for (let i = batchStart; i < batchEnd; i++) {
            const pageNum = i + 1;
            const page = await appState.pdfDocument.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            Object.assign(canvas, { height: viewport.height, width: viewport.width });
            await page.render({ canvasContext: context, viewport }).promise;
            const imageData = canvas.toDataURL('image/jpeg', 0.8);
            if (i === batchStart) {
                elements.chunkPreview.src = imageData;
                elements.chunkPreview.style.display = 'block';
            }
            batchPages.push({ pageNumber: pageNum, imageData });
        }
        const contentTypes = await determineContentTypes(batchPages);
        batchPages.forEach((pageData, i) => {
            const pageIndex = pageData.pageNumber - 1;
            appState.pages[pageIndex].contentType = contentTypes[i];
            appState.processingQueue.push({
                pageNumber: pageData.pageNumber,
                imageData: pageData.imageData,
                contentType: contentTypes[i]
            });
        });
        updateProgressBar(10 + (20 * (batchIndex + 1) / totalBatches));
    }
    
    updateProcessingStep(3);
    updateOverlayStatus('Content analysis complete. Processing pages...');
}

async function determineContentTypes(pages) {
    try {
        const apiKey = elements.apiKey.value.trim();
        if (!apiKey) throw new Error('API key is required');
        const promises = pages.map(async page => {
            const prompt = `Determine if this PDF page contains static content (regular document with paragraphs, headings, tables) or decision tree content (flowcharts, decision points, if-then statements, checklists with conditions).`;
            const messages = [
                { role: "system", content: classificationSystemPrompt },
                { role: "user", content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: page.imageData } }
                ]}
            ];
            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: "anthropic/claude-sonnet-4", messages })
                });
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
                }
                const data = await response.json();
                const content = data.choices[0].message.content.toLowerCase().trim();
                return content.includes('decision') || content.includes('tree') ? 'decision-tree' : 'static';
            } catch (error) {
                console.error(`Error classifying page ${page.pageNumber}:`, error);
                return 'static';
            }
        });
        return await Promise.all(promises);
    } catch (error) {
        console.error('Error determining content types:', error);
        return pages.map(() => 'static');
    }
}

async function processNextInQueue() {
    if (appState.currentlyProcessing || appState.processingQueue.length === 0) {
        if (appState.processingQueue.length === 0 && appState.processedCount === appState.totalPages) {
            finishProcessing();
        }
        return;
    }
    appState.currentlyProcessing = true;
    
    // Count static vs dynamic pages in the queue
    const staticCount = appState.processingQueue.filter(item => item.contentType === 'static').length;
    const dynamicCount = appState.processingQueue.filter(item => item.contentType === 'decision-tree').length;
    
    // Determine batch size based on PDF size and content distribution
    let BATCH_SIZE = appState.totalPages > 10 ? 10 : 3;
    
    // If static pages are significantly more numerous, use larger batches for them
    if (staticCount > dynamicCount * 2) {
        BATCH_SIZE = appState.totalPages > 10 ? 10 : 5;
    }
    
    const staticPages = [];
    const decisionTreePages = [];
    
    // Prioritize static pages if they're more numerous
    if (staticCount > dynamicCount) {
        // Fill batch with static pages first
        for (let i = 0; i < Math.min(BATCH_SIZE, appState.processingQueue.length); i++) {
            const item = appState.processingQueue[i];
            if (item.contentType === 'static' && staticPages.length < BATCH_SIZE) {
                staticPages.push(item);
            } else if (item.contentType === 'decision-tree' && decisionTreePages.length < 3) {
                decisionTreePages.push(item);
            }
        }
        
        // Fill remaining slots with static pages if available
        if (staticPages.length < BATCH_SIZE) {
            for (let i = staticPages.length + decisionTreePages.length; i < appState.processingQueue.length && staticPages.length < BATCH_SIZE; i++) {
                const item = appState.processingQueue[i];
                if (item.contentType === 'static') {
                    staticPages.push(item);
                }
            }
        }
    } else {
        // Original logic for balanced or dynamic-heavy content
        for (let i = 0; i < Math.min(BATCH_SIZE, appState.processingQueue.length); i++) {
            const item = appState.processingQueue[i];
            if (item.contentType === 'static') {
                staticPages.push(item);
            } else {
                decisionTreePages.push(item);
            }
        }
    }
    try {
        const processingPromises = [];
        
        if (staticPages.length > 0) {
            updateOverlayStatus(`Processing ${staticPages.length} static + ${decisionTreePages.length} dynamic pages concurrently...`);
            updateOverlaySubstatus(`Batch size: ${BATCH_SIZE} | Static: ${staticCount}, Dynamic: ${dynamicCount}`);
            processingPromises.push(
                processStaticPagesBatch(staticPages).then(() => {
                    appState.processingQueue = appState.processingQueue.filter(item => 
                        !staticPages.some(processed => processed.pageNumber === item.pageNumber)
                    );
                    appState.processedCount += staticPages.length;
                })
            );
        }
        
        if (decisionTreePages.length > 0) {
            if (staticPages.length === 0) {
                updateOverlayStatus(`Processing ${decisionTreePages.length} decision tree pages...`);
                updateOverlaySubstatus(`Batch size: ${BATCH_SIZE} | Static: ${staticCount}, Dynamic: ${dynamicCount}`);
            }
            processingPromises.push(
                processDecisionTreePagesBatch(decisionTreePages).then(() => {
                    appState.processingQueue = appState.processingQueue.filter(item => 
                        !decisionTreePages.some(processed => processed.pageNumber === item.pageNumber)
                    );
                    appState.processedCount += decisionTreePages.length;
                })
            );
        }
        
        // Wait for all processing to complete concurrently
        await Promise.all(processingPromises);
        updateProgressBar(30 + (70 * appState.processedCount / appState.totalPages));
        
    } catch (error) {
        console.error('Error in batch processing:', error);
        [...staticPages, ...decisionTreePages].forEach(item => {
            const pageIndex = item.pageNumber - 1;
            appState.pages[pageIndex].content = item.contentType === 'static' ? 
                `<div class="alert alert-danger">Error processing page: ${error.message}</div>` : [];
            appState.pages[pageIndex].processed = true;
        });
        appState.processedCount += staticPages.length + decisionTreePages.length;
    } finally {
        appState.currentlyProcessing = false; setTimeout(processNextInQueue, 100);
    }
}

async function processStaticPagesBatch(pages) {
    const results = await convertPagesToHtmlBatch(pages);
    pages.forEach((item, index) => {
        const pageIndex = item.pageNumber - 1;
        appState.pages[pageIndex].content = results[index];
        appState.pages[pageIndex].processed = true;
    });
}

async function processDecisionTreePagesBatch(pages) {
    const results = await extractDecisionTreeFromPagesBatch(pages);
    pages.forEach((item, index) => {
        const pageIndex = item.pageNumber - 1;
        const nodes = results[index];
        appState.decisionTrees[item.pageNumber] = { nodes };
        appState.treeStates[item.pageNumber] = {
            currentNodeId: 'start', pathNodes: ['start'], selectedOptions: {},
            nodeHistory: ['start'], collapsedBranches: {}, treeExpandedState: true
        };
        appState.pages[pageIndex].content = nodes;
        appState.pages[pageIndex].processed = true;
    });
}

async function convertPagesToHtmlBatch(pages) {
    try {
        const apiKey = elements.apiKey.value.trim();
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
                { role: "system", content: staticSystemPrompt },
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

async function extractDecisionTreeFromPagesBatch(pages) {
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey) throw new Error('API key is required');
    const schema = elements.schemaEditor.value;
    const prompt = elements.extractionPrompt.value;
    try {
        const results = await Promise.all(pages.map(async (item) => {
            const messages = [
                { role: 'system', content: decisionTreeSystemPrompt },
                { role: 'user', content: [
                    { type: 'text', text: `${prompt}\n\nSchema: ${schema}` },
                    { type: 'image_url', image_url: { url: item.imageData } }
                ]}
            ]; 
            return { pageNumber: item.pageNumber, messages };
        }));
        const responses = await Promise.all(results.map(async (result) => {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'anthropic/claude-sonnet-4', messages: result.messages })
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`API error for page ${result.pageNumber}: ${errorData.error?.message || response.statusText}`);
            }
            const data = await response.json();
            const content = data.choices[0].message.content;
            const jsonMatch = content.match(/```json([\s\S]*?)```/) || content.match(/```([\s\S]*?)```/) || [null, content];
            const jsonText = jsonMatch[1] || content;
            try {
                return JSON.parse(jsonText.trim());
            } catch (parseError) {
                throw new Error(`Failed to parse decision tree for page ${result.pageNumber}: ${parseError.message}`);
            }
        }));
        return responses;
    } catch (error) {
        console.error('Error in batch decision tree extraction:', error);
        return pages.map(() => []);
    }
}

function finishProcessing() {
    updateProcessingStep(4);
    updateOverlayStatus('Processing complete');
    updateProgressBar(100);
    setTimeout(() => {
        hideProcessingOverlay();
        elements.contentViewer.style.display = 'block';
        // Always show the first page when processing is complete
        appState.currentPage = 1;
        displayPage(1);
    }, 1000);
}

function displayPage(pageNumber) {
    const page = appState.pages[pageNumber - 1];
    if (!page?.processed) {showAlert(`Page ${pageNumber} is not yet processed.`, 'warning'); return;
    }
    appState.currentPage = pageNumber;
    elements.pageCounter.textContent = `Page ${pageNumber} of ${appState.totalPages}`;
    elements.pageTitle.textContent = page.title;
    elements.prevPage.disabled = pageNumber === 1;
    elements.nextPage.disabled = pageNumber === appState.totalPages;
    page.contentType === 'static' ? displayStaticPage(page) : displayDecisionTreePage(page);
}

function displayStaticPage(page) {
    elements.staticContent.style.display = 'block';
    elements.treeContent.style.display = 'none';
    
    // Wrap content in responsive container to prevent overlapping
    const wrappedContent = `
        <div class="pdf-page-wrapper">
            ${page.content}
        </div>
    `;
    
    elements.pageContent.innerHTML = wrappedContent;
    elements.pageContent.scrollTop = 0;
    
    // Fix any remaining absolute positioned elements
    fixOverlappingElements();
}

function displayDecisionTreePage(page) {
    elements.staticContent.style.display = 'none';
    elements.treeContent.style.display = 'block';
    renderTreeVisualization(page.pageNumber);
}

function renderTreeVisualization(pageNumber) {
    const container = elements.treeVisualization;
    container.innerHTML = '';
    const tree = appState.decisionTrees[pageNumber];
    const treeState = appState.treeStates[pageNumber];
    if (!tree || !treeState) return;
    const { nodes } = tree;
    const { currentNodeId } = treeState;
    const createNodeElement = (node, level = 0, isActive = true) => {
        const nodeEl = document.createElement('div');
        nodeEl.className = `tree-node ${node.id === currentNodeId ? 'current' : ''}`;
        nodeEl.dataset.nodeId = node.id;
        nodeEl.style.marginLeft = level > 0 ? `${level * 20}px` : '0';
        const titleEl = document.createElement('div');
        titleEl.className = 'tree-title';
        const titleText = document.createElement('span');
        titleText.textContent = `${node.id} (${node.type || 'Unknown'})`;
        titleText.className = 'fw-bold';
        if (node.id !== currentNodeId && treeState.pathNodes.includes(node.id)) {
            titleText.style.cursor = 'pointer';
            titleText.style.textDecoration = 'underline';
            titleText.onclick = () => navigateToNode(pageNumber, node.id);
        }
        const badge = document.createElement('span');
        badge.className = `badge ${node.id === currentNodeId ? 'bg-success' : 'bg-primary'} tree-badge`;
        badge.textContent = node.id === currentNodeId ? 'Current' : 'Node';
        titleEl.append(titleText, badge);
        nodeEl.appendChild(titleEl);
        const contentEl = document.createElement('div');
        contentEl.textContent = node.question || node.text || '';
        contentEl.className = 'mt-1 mb-2';
        nodeEl.appendChild(contentEl);
        const selectedOption = treeState.selectedOptions[node.id];
        if (selectedOption) {
            const selectedEl = document.createElement('div');
            selectedEl.className = 'selected-option bg-light border-start border-success border-3 rounded px-2 py-1 mb-2';
            selectedEl.innerHTML = `<i class="bi bi-check-circle-fill text-success me-1"></i> Selected: <strong>${selectedOption}</strong>`;
            Object.keys(treeState.collapsedBranches).forEach(branchKey => {
                const [nodeId, option] = branchKey.split(':');
                if (nodeId === node.id && option === selectedOption) {
                    const marker = document.createElement('span');
                    marker.className = 'badge bg-secondary ms-2';
                    marker.innerHTML = '<i class="bi bi-arrows-expand"></i> Show branch';
                    marker.style.cursor = 'pointer';
                    marker.onclick = e => {
                        e.stopPropagation();
                        toggleCollapsedBranch(pageNumber, branchKey);
                    };
                    selectedEl.appendChild(marker);
                }
            });
            nodeEl.appendChild(selectedEl);
        }
        if (isActive) {
            const nextOptions = node.next || node.options || [];
            if (nextOptions.length > 0) {
                const connectorEl = document.createElement('div');
                connectorEl.className = 'tree-connector';
                nodeEl.appendChild(connectorEl);
                const optionsEl = document.createElement('div');
                optionsEl.className = 'tree-options';
                nextOptions.forEach(option => {
                    const optionLabel = option.on || option.label;
                    const optionNext = option.id || option.next;
                    const isSelected = selectedOption === optionLabel;
                    const optionEl = document.createElement('div');
                    optionEl.className = `tree-option ${isSelected ? 'selected' : ''}`;
                    const arrow = document.createElement('span');
                    arrow.className = `option-arrow ${isSelected ? 'text-success' : ''}`;
                    arrow.innerHTML = isSelected ? '✓' : '→';
                    const optionText = document.createElement('span');
                    optionText.textContent = optionLabel;
                    optionText.className = isSelected ? 'fw-bold' : '';
                    const nextNodeId = document.createElement('small');
                    nextNodeId.className = 'ms-1 text-muted';
                    nextNodeId.textContent = `(${optionNext})`;
                    const branchKey = `${node.id}:${optionLabel}`;
                    if (treeState.collapsedBranches[branchKey]) {
                        const marker = document.createElement('span');
                        marker.className = 'badge bg-secondary ms-2';
                        marker.innerHTML = '<i class="bi bi-arrows-expand"></i>';
                        marker.style.cursor = 'pointer';
                        marker.title = 'Show this branch';
                        marker.onclick = e => {
                            e.stopPropagation();
                            toggleCollapsedBranch(pageNumber, branchKey);
                        };
                        optionEl.append(arrow, optionText, nextNodeId, marker);
                    } else {
                        optionEl.style.cursor = 'pointer';
                        optionEl.onclick = () => selectOption(pageNumber, { label: optionLabel, next: optionNext }, node.id);
                        optionEl.append(arrow, optionText, nextNodeId);
                    }
                    optionsEl.appendChild(optionEl);
                });
                nodeEl.appendChild(optionsEl);
            }
        }
        return nodeEl;
    };
    
    const renderPath = [];
    treeState.nodeHistory.forEach((nodeId, historyIndex) => {
        if (treeState.pathNodes.includes(nodeId)) {
            const node = nodes.find(n => n.id === nodeId);
            if (node) {
                const level = treeState.pathNodes.indexOf(nodeId);
                const isActive = nodeId === currentNodeId || historyIndex <= treeState.nodeHistory.indexOf(currentNodeId);
                renderPath.push({ node, level, isActive });
            }
        }
    });
    renderPath.sort((a, b) => a.level - b.level);
    renderPath.forEach(item => container.appendChild(createNodeElement(item.node, item.level, item.isActive)));
    const currentEl = container.querySelector(`.tree-node[data-node-id="${currentNodeId}"]`);
    if (currentEl) currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function selectOption(pageNumber, option, sourceNodeId = null) {
    const treeState = appState.treeStates[pageNumber];
    const tree = appState.decisionTrees[pageNumber];
    if (!treeState || !tree) return;
    const { nodes } = tree;
    const fromNodeId = sourceNodeId || treeState.currentNodeId;
    if (sourceNodeId && treeState.nodeHistory.includes(sourceNodeId)) {
        const sourceIndex = treeState.nodeHistory.indexOf(sourceNodeId);
        if (treeState.selectedOptions[sourceNodeId] && treeState.selectedOptions[sourceNodeId] !== option.label) {
            const branchKey = `${sourceNodeId}:${treeState.selectedOptions[sourceNodeId]}`;
            treeState.collapsedBranches[branchKey] = {
                sourceNodeId,
                option: treeState.selectedOptions[sourceNodeId],
                pathNodes: [...treeState.pathNodes.filter(id => treeState.nodeHistory.indexOf(id) > sourceIndex)],
                nodeHistory: [...treeState.nodeHistory.slice(sourceIndex + 1)]
            };
        }
        treeState.nodeHistory = treeState.nodeHistory.slice(0, sourceIndex + 1);
        treeState.pathNodes = treeState.pathNodes.filter(nodeId => treeState.nodeHistory.indexOf(nodeId) <= sourceIndex);
    }
    treeState.selectedOptions[fromNodeId] = option.label;
    treeState.currentNodeId = option.next;
    if (!treeState.pathNodes.includes(option.next)) {
        treeState.pathNodes.push(option.next);
    }
    treeState.nodeHistory.push(option.next);
    renderTreeVisualization(pageNumber);
}

function navigateToNode(pageNumber, nodeId) {
    const treeState = appState.treeStates[pageNumber];
    if (!treeState || nodeId === treeState.currentNodeId || !treeState.pathNodes.includes(nodeId)) return;
    treeState.currentNodeId = nodeId;
    renderTreeVisualization(pageNumber);
}

function toggleCollapsedBranch(pageNumber, branchKey) {
    const treeState = appState.treeStates[pageNumber];
    if (!treeState) return;
    const branch = treeState.collapsedBranches[branchKey];
    if (!branch) return;
    if (treeState.currentNodeId === branch.sourceNodeId) {
        const currentOption = treeState.selectedOptions[branch.sourceNodeId];
        const currentBranchKey = `${branch.sourceNodeId}:${currentOption}`;
        treeState.collapsedBranches[currentBranchKey] = {
            sourceNodeId: branch.sourceNodeId,
            option: currentOption,
            pathNodes: [...treeState.pathNodes.filter(id => treeState.nodeHistory.indexOf(id) > treeState.nodeHistory.indexOf(branch.sourceNodeId))],
            nodeHistory: [...treeState.nodeHistory.slice(treeState.nodeHistory.indexOf(branch.sourceNodeId) + 1)]
        };
        treeState.selectedOptions[branch.sourceNodeId] = branch.option;
        treeState.nodeHistory = treeState.nodeHistory.slice(0, treeState.nodeHistory.indexOf(branch.sourceNodeId) + 1);
        treeState.nodeHistory.push(...branch.nodeHistory);
        treeState.pathNodes = treeState.pathNodes.filter(id => treeState.nodeHistory.indexOf(id) <= treeState.nodeHistory.indexOf(branch.sourceNodeId));
        treeState.pathNodes.push(...branch.pathNodes);
        treeState.currentNodeId = branch.nodeHistory[branch.nodeHistory.length - 1] || branch.sourceNodeId;
        delete treeState.collapsedBranches[branchKey];
        renderTreeVisualization(pageNumber);
    } else {
        navigateToNode(pageNumber, branch.sourceNodeId);
    }
}

function restartExploration(pageNumber) {
    const page = appState.pages[pageNumber - 1];
    if (page?.contentType === 'decision-tree') {
        appState.treeStates[pageNumber] = {
            currentNodeId: 'start', pathNodes: ['start'], selectedOptions: {},
            nodeHistory: ['start'], collapsedBranches: {}, treeExpandedState: true
        };
        renderTreeVisualization(pageNumber);
    }
}

function exportJson(pageNumber) {
    const page = appState.pages[pageNumber - 1];
    if (page?.contentType === 'decision-tree') {
        const tree = appState.decisionTrees[pageNumber];
        if (!tree) {showAlert('No decision tree available for this page', 'warning'); return;} 
        const blob = new Blob([JSON.stringify(tree, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        Object.assign(a, { href: url, download: `decision-tree-page-${pageNumber}.json` });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } else {
        showAlert('Current page does not contain a decision tree', 'warning');
    }
}

function expandTree() {
    const treeState = appState.treeStates[appState.currentPage];
    if (treeState) {
        treeState.treeExpandedState = true;
        elements.treeVisualization.style.maxHeight = '600px';
        elements.treeVisualization.querySelectorAll('.tree-options').forEach(el => el.style.display = 'block');
    }
}

function collapseTree() {
    const treeState = appState.treeStates[appState.currentPage];
    if (treeState) {
        treeState.treeExpandedState = false;
        elements.treeVisualization.style.maxHeight = '250px';
        elements.treeVisualization.querySelectorAll('.tree-options').forEach(el => el.style.display = 'none');
    }
}

function navigatePage(direction) {
    const newPage = appState.currentPage + (direction === 'prev' ? -1 : 1);
    if (newPage >= 1 && newPage <= appState.totalPages) {
        displayPage(newPage);
    }
}

function goToSpecificPage() {
    const pageNum = parseInt(elements.pageInput.value);
    if (pageNum >= 1 && pageNum <= appState.totalPages) {
        displayPage(pageNum);
        elements.pageInput.value = '';
    } else {
        elements.pageInput.classList.add('is-invalid');
        setTimeout(() => elements.pageInput.classList.remove('is-invalid'), 2000);
    }
}

function cleanupHtml(htmlContent) {
    const match = htmlContent.match(/```(?:html)?\s*([\s\S]*?)\s*```/);
    htmlContent = match ? match[1].trim() : htmlContent;
    return htmlContent.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function showAlert(message, type = 'info') {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show`;
    alertDiv.innerHTML = `${message}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    document.querySelector('.card-body').prepend(alertDiv);
    setTimeout(() => {if (alertDiv.parentNode) {alertDiv.classList.remove('show');
            setTimeout(() => alertDiv.remove(), 150);}
    }, 5000);
}

function showProcessingOverlay(message) {
    elements.overlayStatus.textContent = message;
    elements.overlaySubstatus.textContent = '';
    elements.overlayProgress.style.width = '0%';
    elements.processingOverlay.style.display = 'flex';
    elements.chunkPreview.style.display = 'none';
}

function hideProcessingOverlay() {
    elements.processingOverlay.style.display = 'none';
    elements.chunkPreview.style.display = 'none';
}

const updateOverlayStatus = message => elements.overlayStatus.textContent = message;
const updateOverlaySubstatus = message => elements.overlaySubstatus.textContent = message;

function updateProgressBar(percent) {
    elements.progressBar.style.width = `${percent}%`;
    elements.progressText.textContent = `${Math.round(percent)}%`;
    elements.overlayProgress.style.width = `${percent}%`;
}

function updateProcessingStep(step) {
    [1, 2, 3, 4].forEach(i => {
        elements[`step${i}`].classList.remove('active', 'completed');
        if (i < step) elements[`step${i}`].classList.add('completed');
        else if (i === step) elements[`step${i}`].classList.add('active');
    });
}

function fixOverlappingElements() {
    // Convert any remaining absolute positioned elements to relative flow
    const absoluteElements = elements.pageContent.querySelectorAll('[style*="position: absolute"], .position-absolute');
    absoluteElements.forEach(el => {
        el.style.position = 'relative';
        el.style.display = 'block';
        el.style.marginBottom = '0.5rem';
        el.classList.remove('position-absolute');
        el.classList.add('d-block', 'mb-2');
    });
    
    // Ensure content containers don't overflow
    const containers = elements.pageContent.querySelectorAll('div, section, article');
    containers.forEach(container => {
        container.style.maxWidth = '100%';
        container.style.wordWrap = 'break-word';
        container.style.overflowWrap = 'break-word';
    });
    
    // Fix any elements with fixed width that might cause horizontal scrolling
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

document.addEventListener('DOMContentLoaded', init);