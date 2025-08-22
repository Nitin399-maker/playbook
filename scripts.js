import {classificationSystemPrompt, preschema, extractionPrompt} from './utils.js';
import { displayStaticPage, processStaticPagesBatch,exportHtml} from './static.js';
import { displayDecisionTreePage, processDecisionTreePagesBatch,  restartExploration, exportJson,expandTree, 
collapseTree } from './dynamic.js';
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
    restartBtn: $('restartBtn'), exportJsonBtn: $('exportJsonBtn'), exportHtmlBtn: $('exportHtmlBtn'),
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
    elements.restartBtn.addEventListener('click', () => restartExploration(appState.currentPage, appState, elements));
    elements.exportJsonBtn.addEventListener('click', () => exportJson(appState.currentPage, appState));
    elements.exportHtmlBtn.addEventListener('click', () => exportHtml(appState.currentPage, appState));
    elements.expandTreeBtn.addEventListener('click', () => expandTree(appState, elements));
    elements.collapseTreeBtn.addEventListener('click', () => collapseTree(appState, elements));
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
                    body: JSON.stringify({ model: "openai/gpt-4.1-mini", messages })
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
    const staticCount = appState.processingQueue.filter(item => item.contentType === 'static').length;
    const dynamicCount = appState.processingQueue.filter(item => item.contentType === 'decision-tree').length;
    let BATCH_SIZE = appState.totalPages > 10 ? 10 : 3;
    if (staticCount > dynamicCount * 2) {
        BATCH_SIZE = appState.totalPages > 10 ? 10 : 5;
    }
    const staticPages = [];
    const decisionTreePages = [];

    if (staticCount > dynamicCount) {
        for (let i = 0; i < Math.min(BATCH_SIZE, appState.processingQueue.length); i++) {
            const item = appState.processingQueue[i];
            if (item.contentType === 'static' && staticPages.length < BATCH_SIZE) {
                staticPages.push(item);
            } else if (item.contentType === 'decision-tree' && decisionTreePages.length < 3) {
                decisionTreePages.push(item);
            }
        }
        if (staticPages.length < BATCH_SIZE) {
            for (let i = staticPages.length + decisionTreePages.length; i < appState.processingQueue.length && staticPages.length < BATCH_SIZE; i++) {
                const item = appState.processingQueue[i];
                if (item.contentType === 'static') {
                    staticPages.push(item);
                }
            }
        }
    } else {
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
                processStaticPagesBatch(staticPages, appState).then(() => {
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
                processDecisionTreePagesBatch(decisionTreePages, appState).then(() => {
                    appState.processingQueue = appState.processingQueue.filter(item => 
                        !decisionTreePages.some(processed => processed.pageNumber === item.pageNumber)
                    );
                    appState.processedCount += decisionTreePages.length;
                })
            );
        }
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

function finishProcessing() {
    updateProcessingStep(4);
    updateOverlayStatus('Processing complete');
    updateProgressBar(100);
    setTimeout(() => {
        hideProcessingOverlay();
        elements.contentViewer.style.display = 'block';
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
    page.contentType === 'static' ? displayStaticPage(page, elements, appState) : displayDecisionTreePage(page, elements, appState);
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
document.addEventListener('DOMContentLoaded', init);