// Dynamic/Decision Tree page processing functions

export function displayDecisionTreePage(page, elements, appState) {
    elements.staticContent.style.display = 'none';
    elements.treeContent.style.display = 'block';
    
    // Hide export HTML button for decision tree pages
    if (elements.exportHtmlBtn) {
        elements.exportHtmlBtn.style.display = 'none';
    }
    
    renderTreeVisualization(page.pageNumber, elements, appState);
}

export async function processDecisionTreePagesBatch(pages, appState) {
    const results = await extractDecisionTreeFromPagesBatch(pages, appState);
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

export async function extractDecisionTreeFromPagesBatch(pages, appState) {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) throw new Error('API key is required');
    
    const schema = document.getElementById('schemaEditor').value;
    const prompt = document.getElementById('extractionPrompt').value;
    
    try {
        const results = await Promise.all(pages.map(async (item) => {
            const messages = [
                { role: 'system', content: (await import('./utils.js')).decisionTreeSystemPrompt },
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

export function renderTreeVisualization(pageNumber, elements, appState) {
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
            titleText.onclick = () => navigateToNode(pageNumber, node.id, elements, appState);
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
                        toggleCollapsedBranch(pageNumber, branchKey, elements, appState);
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
                            toggleCollapsedBranch(pageNumber, branchKey, elements, appState);
                        };
                        optionEl.append(arrow, optionText, nextNodeId, marker);
                    } else {
                        optionEl.style.cursor = 'pointer';
                        optionEl.onclick = () => selectOption(pageNumber, { label: optionLabel, next: optionNext }, node.id, elements, appState);
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

export function selectOption(pageNumber, option, sourceNodeId = null, elements, appState) {
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
    renderTreeVisualization(pageNumber, elements, appState);
}

export function navigateToNode(pageNumber, nodeId, elements, appState) {
    const treeState = appState.treeStates[pageNumber];
    if (!treeState || nodeId === treeState.currentNodeId || !treeState.pathNodes.includes(nodeId)) return;
    
    treeState.currentNodeId = nodeId;
    renderTreeVisualization(pageNumber, elements, appState);
}

export function toggleCollapsedBranch(pageNumber, branchKey, elements, appState) {
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
        renderTreeVisualization(pageNumber, elements, appState);
    } else {
        navigateToNode(pageNumber, branch.sourceNodeId, elements, appState);
    }
}

export function restartExploration(pageNumber, appState, elements) {
    const page = appState.pages[pageNumber - 1];
    if (page?.contentType === 'decision-tree') {
        appState.treeStates[pageNumber] = {
            currentNodeId: 'start', pathNodes: ['start'], selectedOptions: {},
            nodeHistory: ['start'], collapsedBranches: {}, treeExpandedState: true
        };
        renderTreeVisualization(pageNumber, elements, appState);
    }
}

export function exportJson(pageNumber, appState) {
    const page = appState.pages[pageNumber - 1];
    if (page?.contentType === 'decision-tree') {
        const tree = appState.decisionTrees[pageNumber];
        if (!tree) {
            showAlert('No decision tree available for this page', 'warning');
            return;
        } 
        
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

export function expandTree(appState, elements) {
    const treeState = appState.treeStates[appState.currentPage];
    if (treeState) {
        treeState.treeExpandedState = true;
        elements.treeVisualization.style.maxHeight = '600px';
        elements.treeVisualization.querySelectorAll('.tree-options').forEach(el => el.style.display = 'block');
    }
}

export function collapseTree(appState, elements) {
    const treeState = appState.treeStates[appState.currentPage];
    if (treeState) {
        treeState.treeExpandedState = false;
        elements.treeVisualization.style.maxHeight = '250px';
        elements.treeVisualization.querySelectorAll('.tree-options').forEach(el => el.style.display = 'none');
    }
}

// Helper function for alerts (shared utility)
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