// 全局变量
let gameMode = 'number'; // 游戏模式：number, poetry, idiom
let gridSize = 3; // 表格大小
let startNumber = 1; // 起始数字
let numberType = 'pure'; // 数字类型：pure, alphanumeric
let gameStarted = false; // 游戏是否开始
let gamePaused = false; // 游戏是否暂停
let startTime = 0; // 开始时间
let elapsedTime = 0; // 已用时间
let timerInterval = null; // 计时器间隔
let currentTarget = 1; // 当前目标
let totalTargets = 0; // 总目标数
let selectedCells = new Set(); // 已选中的单元格
let currentContent = ''; // 当前诗词或成语
let currentContentIndex = 0; // 当前内容索引
let poetryData = []; // 诗词数据
let idiomData = []; // 成语数据
let leaderboard = { // 排行榜数据
    number: {},
    poetry: {},
    idiom: {}
};

// DOM 元素
const gameGrid = document.getElementById('game-grid');
const timerElement = document.getElementById('timer');
const targetElement = document.getElementById('target');
const rangeElement = document.getElementById('range');
const contentTextElement = document.getElementById('content-text');
const gameModeSelect = document.getElementById('game-mode');
const gridSizeSelect = document.getElementById('grid-size');
const startNumberInput = document.getElementById('start-number');
const numberTypeSelect = document.getElementById('number-type');
const startGameBtn = document.getElementById('start-game-btn');
const restartBtn = document.getElementById('restart-btn');
const pauseBtn = document.getElementById('pause-btn');
const gameOverModal = document.getElementById('game-over-modal');
const finalTimeElement = document.getElementById('final-time');
const finalModeElement = document.getElementById('final-mode');
const finalDifficultyElement = document.getElementById('final-difficulty');
const playAgainBtn = document.getElementById('play-again-btn');
const closeModalBtn = document.getElementById('close-modal-btn');
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const closeHelpBtn = document.getElementById('close-help-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const leaderboardLists = {
    number: document.querySelector('#number-leaderboard .leaderboard-list'),
    poetry: document.querySelector('#poetry-leaderboard .leaderboard-list'),
    idiom: document.querySelector('#idiom-leaderboard .leaderboard-list')
};

// 初始化
function init() {
    loadData();
    loadLeaderboard();
    updateLeaderboardDisplay();
    setupEventListeners();
    updateSettingsVisibility();
}

// 加载诗词和成语数据
function loadData() {
    // 加载诗词数据
    fetch('shi.json')
        .then(response => response.json())
        .then(data => {
            poetryData = data;
        })
        .catch(error => {
            console.error('加载诗词数据失败:', error);
            poetryData = [];
        });
    
    // 加载成语数据
    fetch('idiom.json')
        .then(response => response.json())
        .then(data => {
            idiomData = data;
        })
        .catch(error => {
            console.error('加载成语数据失败:', error);
            idiomData = [];
        });
}

// 加载排行榜数据
function loadLeaderboard() {
    const savedLeaderboard = localStorage.getItem('shulteLeaderboard');
    if (savedLeaderboard) {
        const parsedLeaderboard = JSON.parse(savedLeaderboard);
        // 确保数据结构正确
        leaderboard = {
            number: typeof parsedLeaderboard.number === 'object' ? parsedLeaderboard.number : {},
            poetry: typeof parsedLeaderboard.poetry === 'object' ? parsedLeaderboard.poetry : {},
            idiom: typeof parsedLeaderboard.idiom === 'object' ? parsedLeaderboard.idiom : {}
        };
    }
}

// 保存排行榜数据
function saveLeaderboard() {
    localStorage.setItem('shulteLeaderboard', JSON.stringify(leaderboard));
}

// 更新排行榜显示
function updateLeaderboardDisplay() {
    for (const mode in leaderboardLists) {
        const list = leaderboardLists[mode];
        
        list.innerHTML = '';
        
        // 获取当前模式下的所有表格大小
        const sizes = Object.keys(leaderboard[mode]).sort();
        
        if (sizes.length === 0) {
            const emptyItem = document.createElement('li');
            emptyItem.textContent = '暂无记录';
            list.appendChild(emptyItem);
        } else {
            // 为每个表格大小创建一个排行榜部分
            sizes.forEach(size => {
                const sizeItems = leaderboard[mode][size];
                
                // 确保sizeItems是数组
                const itemsArray = Array.isArray(sizeItems) ? sizeItems : [];
                // 只显示前5个记录
                const topItems = itemsArray.slice(0, 5);
                
                // 创建大小标题（可点击折叠/展开）
                const sizeHeader = document.createElement('li');
                sizeHeader.className = 'leaderboard-size-header';
                sizeHeader.innerHTML = `
                    <span class="size-title">${size} 模式</span>
                    <span class="toggle-icon">▼</span>
                `;
                sizeHeader.dataset.size = size;
                sizeHeader.dataset.mode = mode;
                sizeHeader.addEventListener('click', toggleLeaderboardSection);
                list.appendChild(sizeHeader);
                
                // 创建大小对应的排行榜容器
                const leaderboardContainer = document.createElement('li');
                leaderboardContainer.className = 'leaderboard-size-container';
                leaderboardContainer.style.display = 'none'; // 默认折叠
                
                // 创建排行榜内容
                if (topItems.length === 0) {
                    const emptyItem = document.createElement('div');
                    emptyItem.className = 'leaderboard-size-empty';
                    emptyItem.textContent = '暂无记录';
                    leaderboardContainer.appendChild(emptyItem);
                } else {
                    topItems.forEach((item, index) => {
                        const listItem = document.createElement('div');
                        listItem.className = 'leaderboard-item';
                        
                        // 格式化完成时间为简短格式
                        let dateStr = '';
                        if (item.timestamp) {
                            const date = new Date(item.timestamp);
                            const month = date.getMonth() + 1;
                            const day = date.getDate();
                            const hours = date.getHours().toString().padStart(2, '0');
                            const minutes = date.getMinutes().toString().padStart(2, '0');
                            dateStr = `${month}/${day} ${hours}:${minutes}`;
                        }
                        
                        listItem.innerHTML = `
                            <span class="rank">${index + 1}.</span>
                            <span class="time">${item.time}</span>
                            <span class="date">${dateStr}</span>
                        `;
                        leaderboardContainer.appendChild(listItem);
                    });
                }
                
                list.appendChild(leaderboardContainer);
            });
        }
    }
}

// 切换排行榜部分的折叠/展开状态
function toggleLeaderboardSection(event) {
    const header = event.currentTarget;
    const container = header.nextElementSibling;
    const toggleIcon = header.querySelector('.toggle-icon');
    
    if (container.style.display === 'none') {
        // 展开
        container.style.display = 'block';
        toggleIcon.textContent = '▲';
    } else {
        // 折叠
        container.style.display = 'none';
        toggleIcon.textContent = '▼';
    }
}

// 添加排行榜记录
function addLeaderboardRecord(mode, time, gridSize) {
    const sizeKey = `${gridSize}x${gridSize}`;
    // 确保模式和大小的数组存在
    if (!leaderboard[mode][sizeKey]) {
        leaderboard[mode][sizeKey] = [];
    }
    // 添加带时间戳的记录
    leaderboard[mode][sizeKey].push({ 
        time, 
        timestamp: new Date().getTime() 
    });
    leaderboard[mode][sizeKey].sort((a, b) => {
        // 正确分割时间字符串
        const parseTime = (timeStr) => {
            const parts = timeStr.split(':');
            const minutes = parseInt(parts[0]);
            const secondsParts = parts[1].split('.');
            const seconds = parseInt(secondsParts[0]);
            const milliseconds = parseInt(secondsParts[1]) || 0;
            return minutes * 60 + seconds + milliseconds / 100;
        };
        
        const totalA = parseTime(a.time);
        const totalB = parseTime(b.time);
        return totalA - totalB;
    });
    leaderboard[mode][sizeKey] = leaderboard[mode][sizeKey].slice(0, 5); // 只保留前5名
    saveLeaderboard();
    updateLeaderboardDisplay();
}

// 设置事件监听器
function setupEventListeners() {
    // 开始游戏
    startGameBtn.addEventListener('click', startGame);
    
    // 重新开始
    restartBtn.addEventListener('click', startGame);
    
    // 暂停/继续
    pauseBtn.addEventListener('click', togglePause);
    
    // 游戏结束模态框
    playAgainBtn.addEventListener('click', () => {
        gameOverModal.classList.remove('show');
        startGame();
    });
    
    closeModalBtn.addEventListener('click', () => {
        gameOverModal.classList.remove('show');
    });
    
    // 帮助模态框
    helpBtn.addEventListener('click', () => {
        helpModal.classList.add('show');
    });
    
    closeHelpBtn.addEventListener('click', () => {
        helpModal.classList.remove('show');
    });
    
    // 全屏按钮
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    
    // 设置按钮
    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });
    
    cancelSettingsBtn.addEventListener('click', () => {
        settingsPanel.classList.add('hidden');
    });
    
    // 游戏模式选择
    gameModeSelect.addEventListener('change', updateSettingsVisibility);
    
    // 排行榜标签切换
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            
            // 更新标签状态
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // 更新内容显示
            tabContents.forEach(content => content.classList.remove('active'));
            document.getElementById(`${tab}-leaderboard`).classList.add('active');
        });
    });
    
    // 全屏变化监听
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
}

// 更新设置可见性
function updateSettingsVisibility() {
    const mode = gameModeSelect.value;
    const startNumberGroup = document.getElementById('start-number-group');
    const numberTypeGroup = document.getElementById('number-type-group');
    
    if (mode === 'number') {
        startNumberGroup.classList.remove('hidden');
        numberTypeGroup.classList.remove('hidden');
    } else {
        startNumberGroup.classList.add('hidden');
        numberTypeGroup.classList.add('hidden');
    }
}

// 开始游戏
function startGame() {
    // 获取设置
    gameMode = gameModeSelect.value;
    gridSize = parseInt(gridSizeSelect.value);
    startNumber = parseInt(startNumberInput.value);
    numberType = numberTypeSelect.value;
    
    // 重置游戏状态
    gameStarted = true;
    gamePaused = false;
    selectedCells.clear();
    currentTarget = 1;
    currentContentIndex = 0;
    elapsedTime = 0;
    
    // 隐藏设置面板
    settingsPanel.classList.add('hidden');
    
    // 生成游戏表格
    generateGameGrid();
    
    // 更新游戏状态显示
    updateGameStatus();
    
    // 开始计时
    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 10);
    
    // 更新暂停按钮文本
    pauseBtn.textContent = '暂停';
}

// 生成游戏表格
function generateGameGrid() {
    gameGrid.innerHTML = '';
    gameGrid.className = `game-grid grid-${gridSize}x${gridSize}`;
    
    let cells = [];
    totalTargets = gridSize * gridSize;
    
    if (gameMode === 'number') {
        // 数字模式
        if (numberType === 'pure') {
            // 纯数字
            for (let i = startNumber; i < startNumber + totalTargets; i++) {
                cells.push(i.toString());
            }
        } else {
            // 数字+字母
            const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            // 生成唯一字符序列
            let uniqueChars = [];
            let charIndex = 0;
            while (uniqueChars.length < totalTargets) {
                const currentChar = chars[charIndex % chars.length];
                uniqueChars.push(currentChar);
                charIndex++;
            }
            cells = uniqueChars;
        }
    } else if (gameMode === 'poetry') {
        // 诗词模式
        if (poetryData.length > 0) {
            const randomPoem = poetryData[Math.floor(Math.random() * poetryData.length)];
            currentContent = randomPoem.paragraphs.join('');
            // 只保留中文字符，过滤掉所有非中文字符
            const finalCleanedContent = currentContent.replace(/[^\u4e00-\u9fa5]/g, '');
            
            
            // 确保有足够的字符
            if (finalCleanedContent.length >= totalTargets) {
                cells = finalCleanedContent.substring(0, totalTargets).split('');
            } else {
                // 如果诗词长度不够，重复填充
                while (cells.length < totalTargets) {
                    cells = cells.concat(finalCleanedContent.split(''));
                }
                cells = cells.slice(0, totalTargets);
            }
        } else {
            // 如果没有诗词数据，使用默认数字
            for (let i = 1; i <= totalTargets; i++) {
                cells.push(i.toString());
            }
            currentContent = '暂无诗词数据';
        }
    } else if (gameMode === 'idiom') {
        // 成语模式
        if (idiomData.length > 0) {
            let idioms = [];
            while (idioms.length * 4 < totalTargets) {
                const randomIdiom = idiomData[Math.floor(Math.random() * idiomData.length)];
                idioms.push(randomIdiom.word);
            }
            currentContent = idioms.join(' ');
            let combinedIdioms = idioms.join('');
            // 只保留中文字符，过滤掉所有非中文字符
            combinedIdioms = combinedIdioms.replace(/[^\u4e00-\u9fa5]/g, '');
            
            // 确保有足够的字符
            if (combinedIdioms.length >= totalTargets) {
                cells = combinedIdioms.substring(0, totalTargets).split('');
            } else {
                // 如果成语长度不够，重复填充
                while (cells.length < totalTargets) {
                    cells = cells.concat(combinedIdioms.split(''));
                }
                cells = cells.slice(0, totalTargets);
            }
        } else {
            // 如果没有成语数据，使用默认数字
            for (let i = 1; i <= totalTargets; i++) {
                cells.push(i.toString());
            }
            currentContent = '暂无成语数据';
        }
    }
    
    // 随机打乱单元格
    shuffleArray(cells);
    
    // 创建单元格
    cells.forEach((cell, index) => {
        const cellElement = document.createElement('div');
        cellElement.className = 'grid-cell';
        cellElement.textContent = cell;
        cellElement.dataset.value = cell;
        cellElement.dataset.index = index;
        cellElement.addEventListener('click', handleCellClick);
        gameGrid.appendChild(cellElement);
    });
    
    // 更新内容显示
    if (gameMode === 'number') {
        contentTextElement.textContent = ' ';
    } else {
        contentTextElement.textContent = currentContent;
    }
}

// 处理单元格点击
function handleCellClick(event) {
    if (!gameStarted || gamePaused) return;
    
    const cell = event.target;
    const value = cell.dataset.value;
    
    // 检查是否已经选中
    if (selectedCells.has(cell)) return;
    
    if (gameMode === 'number') {
        // 数字模式
        if (numberType === 'pure') {
            // 纯数字
            if (parseInt(value) === currentTarget + startNumber - 1) {
                markCellCorrect(cell);
                currentTarget++;
                updateGameStatus();
                checkGameOver();
            }
        } else {
            // 数字+字母
            const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            const targetChar = chars[(currentTarget - 1) % chars.length];
            if (value === targetChar && !selectedCells.has(cell)) {
                markCellCorrect(cell);
                currentTarget++;
                updateGameStatus();
                checkGameOver();
            }
        }
    } else if (gameMode === 'poetry' || gameMode === 'idiom') {
        // 诗词或成语模式
        const cleanedContent = currentContent.replace(/[^\u4e00-\u9fa5]/g, '');
        if (value === cleanedContent[currentContentIndex]) {
            markCellCorrect(cell);
            currentContentIndex++;
            currentTarget++;
            updateGameStatus();
            checkGameOver();
        }
    }
}

// 标记单元格为正确
function markCellCorrect(cell) {
    cell.classList.add('correct');
    selectedCells.add(cell);
}

// 更新游戏状态
function updateGameStatus() {
    if (gameMode === 'number' && numberType === 'pure') {
        // 纯数字模式
        targetElement.textContent = currentTarget + startNumber - 1;
        rangeElement.textContent = `${startNumber}-${startNumber + totalTargets - 1}`;
    } else if (gameMode === 'number' && numberType === 'alphanumeric') {
        // 数字+字母模式
        const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const targetChar = chars[(currentTarget - 1) % chars.length];
        targetElement.textContent = targetChar;
        rangeElement.textContent = `0-9A-Z`;
    } else if (gameMode === 'poetry' || gameMode === 'idiom') {
        // 诗词或成语模式
        const cleanedContent = currentContent.replace(/[^\u4e00-\u9fa5]/g, '');
        if (currentContentIndex < cleanedContent.length) {
            targetElement.textContent = cleanedContent[currentContentIndex];
        } else {
            targetElement.textContent = '完成';
        }
        rangeElement.textContent = `1-${totalTargets}`;
    } else {
        // 其他模式
        targetElement.textContent = currentTarget;
        rangeElement.textContent = `1-${totalTargets}`;
    }
}

// 检查游戏是否结束
function checkGameOver() {
    if (currentTarget > totalTargets) {
        endGame();
    }
}

// 结束游戏
function endGame() {
    gameStarted = false;
    clearInterval(timerInterval);
    
    // 计算最终时间
    const finalTime = formatTime(elapsedTime);
    
    // 更新模态框
    finalTimeElement.textContent = finalTime;
    finalModeElement.textContent = getGameModeText(gameMode);
    finalDifficultyElement.textContent = `${gridSize}x${gridSize}`;
    
    // 显示模态框
    gameOverModal.classList.add('show');
    
    // 添加排行榜记录
    addLeaderboardRecord(gameMode, finalTime, gridSize);
}

// 暂停/继续游戏
function togglePause() {
    if (!gameStarted) return;
    
    gamePaused = !gamePaused;
    
    if (gamePaused) {
        // 暂停
        clearInterval(timerInterval);
        pauseBtn.textContent = '继续';
    } else {
        // 继续
        startTime = Date.now() - elapsedTime;
        timerInterval = setInterval(updateTimer, 10);
        pauseBtn.textContent = '暂停';
    }
}

// 更新计时器
function updateTimer() {
    if (!gameStarted || gamePaused) return;
    
    elapsedTime = Date.now() - startTime;
    timerElement.textContent = formatTime(elapsedTime);
}

// 格式化时间
function formatTime(ms) {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const centiseconds = Math.floor((ms % 1000) / 10);
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
}

// 切换全屏
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        // 进入全屏
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.mozRequestFullScreen) {
            document.documentElement.mozRequestFullScreen();
        } else if (document.documentElement.msRequestFullscreen) {
            document.documentElement.msRequestFullscreen();
        }
    } else {
        // 退出全屏
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
}

// 处理全屏变化
function handleFullscreenChange() {
    if (document.fullscreenElement) {
        document.body.classList.add('fullscreen');
        fullscreenBtn.textContent = '退出全屏';
    } else {
        document.body.classList.remove('fullscreen');
        fullscreenBtn.textContent = '全屏';
    }
}

// 获取游戏模式文本
function getGameModeText(mode) {
    switch (mode) {
        case 'number':
            return '数字模式';
        case 'poetry':
            return '诗词模式';
        case 'idiom':
            return '成语模式';
        default:
            return '未知模式';
    }
}

// 随机打乱数组
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// 初始化游戏
init();
