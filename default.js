// default.js 視覺渲染 - 負責 Three.js 的初始化與運行

import * as THREE from 'three';
import { handleInteraction } from './interaction.js';

// --- 預設參數 ---
const MAX_PARTICLES = 1000; // 緩衝區上限
const DEFAULT_PARTICLE_COUNT = 200;
// 初始畫面需要有足夠明顯的流動感；1 在目前的鏡頭尺度下近似靜止。
const DEFAULT_SPEED_FACTOR = 0.01;
const DEFAULT_AROUSAL = 0;
const DEFAULT_RANGE = 400;

// --- 全域變數 ---
let scene, camera, renderer, particles, material, particleData = [];
let particleCount = DEFAULT_PARTICLE_COUNT; // 這是目前要畫出來的數量
let currentSpeedFactor = DEFAULT_SPEED_FACTOR; // 儲存新增速度
let currentArousal = DEFAULT_AROUSAL; // 記錄情緒能量
let currentRange = DEFAULT_RANGE; // 全域範圍變數
let emotionPool = []; // 儲存 JSON 數據
let clickCount = 0;
let port, reader;  // 串Arduino-IDE
// let pulseScale = 1.0;       // 當前粒子縮放比例 (正常為 1) - 心跳節奏震動控制變數
// let targetScale = 1.0;      // 目標縮放比例 - 心跳節奏震動控制變數
// let pulseIntensity = 0.3;   // 心跳突發震動的強度 (數值越大跳動幅度越劇烈) - 心跳節奏震動控制變數

// 心律與連線狀態
let waveCanvas, waveCtx;    // 心律波長，開始畫面預設
let bpmHistory = [];        // 預設清空，未連線前不載入偽數據，接收後儲存最近收到的 BPM 數據
let isSerialConnected = false;     // 紀錄目前是否已成功連線並開始接收資料
let lastValidBPM = 70;             // 紀錄上一次有效的 BPM 數值
let lastDataReceivedTime = Date.now(); // 紀錄最後一次收到 Serial 資料的時間
let currentBPM = 0;  // 避免 ReferenceError

// Tone.js 聲音
let synth, polySynth;
let pianoSynth;   // 溫柔抒情：鋼琴/電鋼琴 (愛意、表象平靜)
let marimbaSynth; // 輕快跳躍：木琴/馬林巴 (喜悅、輕鬆)
let celloSynth;   // 沉重壓抑：低音大提琴/鋸齒波 (悲傷、內心撕裂)
let noiseSynth;   // 緊迫撞擊：金屬感打擊樂 (憤怒、焦慮)
let currentEmotionLoop = null;      // 當前情緒旋律循環
let currentEmotion = null;

// 全域變數鎖定，防止重複連線
let currentPort = null;
const r = 800;

async function init() {
    // 抓取 JSON 情緒資料
    try {
        const response = await fetch('./emotions.json');
        emotionPool = await response.json();
        console.log("情緒資料載入成功:", emotionPool);
        refreshTags(); // 資料抓到後立刻生成標籤
    } catch (error) {
        console.error("讀取情緒檔案失敗:", error);
    }

    // 初始化 Three.js 場景
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000); // 背景基底色

    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 4000);
    camera.position.z = 1000;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // 監聽 Arduino 連線按鈕
    const connectBtn = document.querySelector('#connect-arduino');
    if (connectBtn) {
        connectBtn.addEventListener('click', async () => {
            if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
                await Tone.start();
            }
            connectSerial(); // 執行 Serial 連線機制
        });
    }

    // 綁定波形 Canvas 並啟動動畫迴圈
    waveCanvas = document.getElementById('waveCanvas');
    if (waveCanvas) {
        waveCtx = waveCanvas.getContext('2d');
        // 設定 Canvas 實際渲染解析度（避免畫線變模糊）
        waveCanvas.width = waveCanvas.clientWidth || 200;
        waveCanvas.height = waveCanvas.clientHeight || 50;
    }

    setupParticles();
    setupLines();
    setupAudioEngine();
    drawWaveform();
    animate();
}

// 重置機制：恢復到最初預設畫面與參數
function resetToDefaultState() {
    console.log("超過 15 秒無數據，自動重置為初始體驗畫面...");

    // 清空心率數據歷史與數字
    bpmHistory = [];
    currentBPM = 75;
    const bpmValEl = document.getElementById('bpmValue');
    if (bpmValEl) bpmValEl.textContent = '--';

    // 還原 Three.js 視覺參數到預設值
    currentSpeedFactor = DEFAULT_SPEED_FACTOR;
    currentArousal = DEFAULT_AROUSAL;
    currentRange = DEFAULT_RANGE;
    particleCount = DEFAULT_PARTICLE_COUNT;

    // 還原粒子數量與預設色彩 (白色/灰白色)
    if (particles) {
        particles.setDrawRange(0, particleCount);
        const colorAttribute = particles.attributes.color;
        for (let i = 0; i < MAX_PARTICLES; i++) {
            colorAttribute.array[i * 3] = 1;
            colorAttribute.array[i * 3 + 1] = 1;
            colorAttribute.array[i * 3 + 2] = 1;
        }
        colorAttribute.needsUpdate = true;
    }

    // 還原背景顏色與連線顏色
    if (scene) scene.background.setHex(0x000000);
    if (material) material.color.setHex(0xffffff);

    // 清除文字選項的高亮狀態，並隨機換一批新的違心話台詞
    document.querySelectorAll('.tag-item').forEach(el => el.classList.remove('active'));
    refreshTags();
}

// 獨立出來的情緒視覺更新轉譯器，直接接收選單文字
function updateEmotionVisual(res) {
    if (!res || !particles) return; // 防錯

    // 控制粒子大小
    const {
        s = 13,
        range = DEFAULT_RANGE,
        newCount = DEFAULT_PARTICLE_COUNT,
        speedFactor = DEFAULT_SPEED_FACTOR,
        a = DEFAULT_AROUSAL,
        hue = 0
    } = res.visual;

    scene.traverse((object) => {
        if (object instanceof THREE.Points) {
            object.material.size = s;
            object.material.needsUpdate = true;
        }
    });

    // 更新全域範圍變數 (range)
    currentRange = range;

    // 更新全域範圍變數 - 數量
    particleCount = Math.floor(newCount);
    particles.setDrawRange(0, Math.min(particleCount, MAX_PARTICLES));

    // 如果序列埠 reader 存在且正在讀取，就不由文字覆蓋速度與能量，確保點擊文字時，心率帶來的激烈流速不會突然斷掉
    if (!reader) {
        currentSpeedFactor = speedFactor;
        currentArousal = a;
    } else {
        console.log("偵測到心率連線中，文字跳過覆蓋速度與能量，僅更新視覺色彩。");
    }

    // 更新粒子顏色
    const particleTargetColor = new THREE.Color();
    particleTargetColor.setHSL(hue / 360, 0.8, 0.6);

    const colorAttribute = particles.attributes.color;
    for (let i = 0; i < MAX_PARTICLES; i++) {
        colorAttribute.array[i * 3] = particleTargetColor.r;
        colorAttribute.array[i * 3 + 1] = particleTargetColor.g;
        colorAttribute.array[i * 3 + 2] = particleTargetColor.b;
    }
    colorAttribute.needsUpdate = true;

    // 更新背景顏色
    scene.background.setHSL(hue / 360, 0.9, 0.05);
    if (material) material.color.copy(particleTargetColor);
}

// 隨機文字上下滾動選單功能
function refreshTags() {
    const container = document.querySelector('#suggestion-tags');
    if (!container || emotionPool.length === 0) return;

    container.innerHTML = '';

    // 只從有 outerText 的情緒中，隨機取出 8 筆
    const selected = emotionPool
        .filter((item) => typeof item?.text?.outerText === 'string' && item.text.outerText.trim())
        .sort(() => 0.5 - Math.random())
        .slice(0, 8);

    selected.forEach((item) => {
        const outerText = item.text.outerText;
        const div = document.createElement('div');
        div.className = 'tag-item';
        div.innerText = outerText; // 顯示違心話

        // 點擊事件監聽
        div.onclick = async () => {
            console.log("點擊了選項：", outerText);

            // 確保點擊時啟動聲音引擎
            if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
                await Tone.start();
                console.log("AudioContext 透過點擊成功啟動！");
            }

            // 樣式切換
            document.querySelectorAll('.tag-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');

            // 自動平滑滾動到畫面正中間
            div.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 取得整合後的視覺與聲音參數
            currentEmotion = handleInteraction(outerText, emotionPool);

            if (currentEmotion) {
                // 更新 Three.js 視覺
                updateEmotionVisual(currentEmotion);

                // 確保 AudioContext 已啟動並播放聲音
                if (typeof Tone !== 'undefined') {
                    if (Tone.context.state !== 'running') {
                        await Tone.start();
                    }
                    // 直接調用 playEmotionSound 播放情緒旋律
                    playEmotionSound(currentEmotion);
                }
            }

            // 點擊計數與自動換批機制
            clickCount++;
            if (clickCount >= 2) {
                clickCount = 0;
                setTimeout(() => {
                    refreshTags(); // 點擊兩次後自動更換下一組滾動台詞
                }, 1000);
            }
        };
        container.appendChild(div); // 確保點擊時啟動音訊引擎
    });
}

// Web Serial 連線與讀取函式 - Arduino
async function connectSerial() {
    if ('serial' in navigator) {
        try {
            // 確保點擊按鈕時啟動 Tone.js 音效引擎
            if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
                await Tone.start();
                console.log("Tone.js 音訊引擎已成功啟動！");
            }

            // 請求使用者選擇裝置 Arduino 的 COM Port
            port = await navigator.serial.requestPort();
            await port.open({ baudRate: 115200 });
            console.log("Serial 連線成功！");

            // 標記為已連線
            isSerialConnected = true;
            lastDataReceivedTime = Date.now();
            bpmHistory = Array(20).fill(70);

            const connectBtn = document.querySelector('#connect-arduino');
            if (connectBtn) {
                connectBtn.innerText = "🔴 已連線";
                connectBtn.style.background = "#ff4d4d";
            }

            // 開始讀取資料流 (把之前被註解掉的邏輯取消註解)
            const textDecoder = new TextDecoderStream();
            const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
            reader = textDecoder.readable.getReader();

            let buffer = "";
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    reader.releaseLock();
                    break;
                }
                if (value) {
                    buffer += value;
                    if (buffer.includes('\n')) {
                        const lines = buffer.split('\n');
                        buffer = lines.pop(); // 留下最後不完整的一行

                        for (const line of lines) {
                            processSerialData(line.trim());
                        }
                    }
                }
            }
        } catch (error) {
            console.warn(" Serial 連線失敗或使用者取消選取：", error.message);
        }
    } else {
        alert("您的瀏覽器不支援 Web Serial API，請使用 Google Chrome 或 Microsoft Edge 瀏覽器。");
    }
}

// 處理從 Arduino 傳來的資料
function processSerialData(data) {
    try {
        const trimmedData = data.trim();
        if (trimmedData.startsWith('BPM:')) {
            const bpmValue = parseInt(trimmedData.replace('BPM:', ''), 10);

            // 排除過低 (<40) 或過高 (>200) 的極端雜訊數值
            if (!isNaN(bpmValue) && bpmValue >= 40 && bpmValue <= 220) {

                currentBPM = bpmValue; // 更新全域 BPM
                lastValidBPM = bpmValue;   // 紀錄最新的有效 BPM
                lastDataReceivedTime = Date.now(); // 更新收到資料的時間戳記
                Tone.Transport.bpm.value = bpmValue; // 動態更新 Tone.js Transport BPM

                // 記錄 BPM 歷史數據以更新波形
                bpmHistory.push(bpmValue);
                if (bpmHistory.length > 30) {
                    bpmHistory.shift();
                }

                console.log(`從感測器收到即時心率❤️❤️❤️ BPM: ${currentBPM}`);

                // 更新 HTML 顯示
                const bpmDisplay = document.getElementById('bpmValue');
                if (bpmDisplay) {
                    bpmDisplay.innerText = currentBPM;
                }

                // 粒子速度與能量連動
                currentSpeedFactor = 0.5 + (bpmValue / 70);
                currentArousal = (bpmValue - 70) / 30;

            } else {
                console.warn(`收到異常心律數據，已自動過濾: ${bpmValue}`);
            }
        }
    } catch (error) {
        console.error("解析 Serial 數據時發生錯誤:", error);
    }
}

// 心率波形動畫/偵測心律數據
function drawWaveform() {
    requestAnimationFrame(drawWaveform);
    if (!waveCtx || !waveCanvas) return;

    const width = waveCanvas.width;
    const height = waveCanvas.height;

    // 每一幀繪製前一定要清空畫布，避免歷史畫痕疊加成紅塊
    waveCtx.clearRect(0, 0, width, height);

    // 檢查是否超過 15 秒沒有收到感測器數據（代表沒人在測或離線）
    const now = Date.now();
    if (isSerialConnected && now - lastDataReceivedTime > 15000) {
        // 若歷史紀錄還留著數據，說明是剛滿 15 秒的第一時間，觸發一次全域歸零
        if (bpmHistory.length > 0) {
            resetToDefaultState();
        }
    }
    // 未連線狀態 或 無數據時 - 顯示一條靜止平坦的待機灰線
    if (!isSerialConnected || bpmHistory.length < 2) {
        waveCtx.strokeStyle = '#2a2a3a';
        waveCtx.lineWidth = 1;
        waveCtx.beginPath();
        waveCtx.moveTo(0, height / 2);
        waveCtx.lineTo(width, height / 2);
        waveCtx.stroke();
        return;
    }

    // 固定縱軸範圍：最低 40 BPM，最高至少 160 BPM（或隨最大值動態往上擴展）
    const min = 40;
    let max = Math.max(...bpmHistory, 160);
    const range = max - min;

    // 計算波形座標 (y 軸會精準對應 40 ~ max)
    const getPointY = (v) => {
        // 將數值限制在 min ~ max 之間
        const clampedVal = Math.max(min, Math.min(max, v));
        // 留出上下 10% 的邊界Padding避免貼邊，其餘依比例映射
        const normalized = (clampedVal - min) / range;
        return height - (normalized * height * 0.8 + height * 0.1);
    };

    // 背景漸層區域
    const grad = waveCtx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(255, 59, 92, 0.2)');
    grad.addColorStop(1, 'rgba(255, 59, 92, 0)');

    waveCtx.beginPath();
    bpmHistory.forEach((v, i) => {
        const x = (i / (bpmHistory.length - 1)) * width;
        const y = getPointY(v);
        if (i === 0) waveCtx.moveTo(x, y);
        else waveCtx.lineTo(x, y);
    });
    waveCtx.lineTo(width, height);
    waveCtx.lineTo(0, height);
    waveCtx.closePath();
    waveCtx.fillStyle = grad;
    waveCtx.fill();

    // 折線波形
    waveCtx.beginPath();
    bpmHistory.forEach((v, i) => {
        const x = (i / (bpmHistory.length - 1)) * width;
        const y = getPointY(v);
        if (i === 0) waveCtx.moveTo(x, y);
        else waveCtx.lineTo(x, y);
    });

    waveCtx.strokeStyle = '#ff3b5c';
    waveCtx.lineWidth = 1;         // 線條粗細
    waveCtx.shadowBlur = 2;        // 光暈強度
    waveCtx.lineJoin = 'round';
    waveCtx.shadowColor = '#ff3b5c';
    waveCtx.stroke();
}

function createPianoSynth() {
    // 溫柔鋼琴質感 (Piano)
    const instrument = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.05, decay: 1.5, sustain: 0.3, release: 2.0 }
    }).toDestination();
    instrument.volume.value = -6;
    return instrument;
}

// 建立聲音引擎
function setupAudioEngine() {
    if (Tone.context.state !== 'running') {
        Tone.start();
    }

    pianoSynth = createPianoSynth();

    // 圓潤木琴質感 (Marimba)
    marimbaSynth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sine" },
        envelope: { attack: 0.01, decay: 0.6, sustain: 0.1, release: 0.8 }
    }).toDestination();
    marimbaSynth.volume.value = -4;

    // 深沉大提琴/低音質感 (Cello/Bass)
    celloSynth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "sawtooth" },
        envelope: { attack: 0.3, decay: 2.0, sustain: 0.7, release: 2.5 }
    }).toDestination();
    celloSynth.volume.value = -10; // 沉在背景

    // 金屬壓迫質感 (Percussive Anger)
    noiseSynth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "square" },
        envelope: { attack: 0.005, decay: 0.2, sustain: 0.01, release: 0.3 }
    }).toDestination();
    noiseSynth.volume.value = -12;
}


function stopCurrentEmotionAudio() {
    if (currentEmotionLoop) {
        currentEmotionLoop.stop();
        currentEmotionLoop.dispose();
        currentEmotionLoop = null;
    }

    if (pianoSynth) {
        pianoSynth.releaseAll();
        pianoSynth.dispose();
        pianoSynth = createPianoSynth();
    }
    if (marimbaSynth) marimbaSynth.releaseAll();
    if (celloSynth) celloSynth.releaseAll();
    if (noiseSynth) noiseSynth.releaseAll();
}

// Tone.js 情緒聲音播放函式 (主入口)
async function playEmotionSound(currentEmotion) {
    if (Tone.context.state !== 'running') {
        await Tone.start();
    }

    console.log("進入 playEmotionSound，接收到的參數：", currentEmotion);

    stopCurrentEmotionAudio();

    const now = Tone.now();

    // --- 觸發【表面視覺】旋律與循環 ---
    currentEmotionLoop = playSingleEmotion(currentEmotion, Tone.Transport.seconds + 0.02, false);
    if (Tone.Transport.state !== 'started') {
        Tone.Transport.start(now + 0.02);
    }
}

// 播放單一情緒旋律的子函式 (樂器與旋律綁定)
function playSingleEmotion(currentEmotion, startTime = Tone.Transport.seconds, isInner = false) {
    const key = currentEmotion.key
    const notes = currentEmotion.music.notes
    const melody = currentEmotion.music.melody;
    const intervals = currentEmotion.music.intervals;
    // 播放設定
    const synth = isInner ? celloSynth : pianoSynth;
    const velocity = isInner ? 0.45 : 0.60;
    const startAt = Math.max(Number(startTime) || 0, Tone.Transport.seconds + 0.02);
    const loopDuration = intervals.reduce((sum, value) => sum + value, 0);

    // 永遠建立循環 (移除 shouldLoop 條件)
    if (loopDuration <= 0) {
        console.warn(`[${key}] 無效的 loop 長度`, loopDuration);
        return null;
    }

    let offset = 0;
    const events = melody.map((id, index) => {
        const interval = intervals[index];
        const event = {
            time: offset,
            note: notes[id],
            duration: Math.min(interval * 0.72, 1.8)
        };
        offset += interval;
        return event;
    });

    // 每個音獨立交給 Transport 排程，切換情緒時才能取消尚未播放的舊音符。
    const loop = new Tone.Part((time, event) => {
        synth.triggerAttackRelease(event.note, event.duration, time, velocity);
    }, events);

    loop.loop = true;
    loop.loopEnd = loopDuration;
    loop.start(startAt);

    console.log("🎵 固定循環情緒旋律", currentEmotion);
    return loop;
}

// 粒子設定
function setupParticles() {
    const particlePositions = new Float32Array(MAX_PARTICLES * 3); // 粒子陣列
    const particleColors = new Float32Array(MAX_PARTICLES * 3); // 顏色陣列

    // 使用 VertexColors
    const pMaterial = new THREE.PointsMaterial({
        size: 15,
        map: createCircleTexture(),
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false
    });

    for (let i = 0; i < MAX_PARTICLES; i++) {
        // 粒子顏色隨機差異
        particlePositions[i * 3] = Math.random() * r - r / 2;
        particlePositions[i * 3 + 1] = Math.random() * r - r / 2;
        particlePositions[i * 3 + 2] = Math.random() * r - r / 2;

        particleData.push({
            velocity: new THREE.Vector3(-1 + Math.random() * 2, -1 + Math.random() * 2, -1 + Math.random() * 2)
        });

        // 這裡就是初始 RGB 顏色 (0 ~ 1 之間)
        // 目前是 0.5, 0.5, 0.5，代表「中灰色」
        // 亮白： 改成 1.0 : 想變全黑（隱形）： 全部改成 0
        particleColors[i * 3] = 1;
        particleColors[i * 3 + 1] = 1;
        particleColors[i * 3 + 2] = 1;

    }

    particles = new THREE.BufferGeometry();
    particles.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3).setUsage(THREE.DynamicDrawUsage));
    particles.setAttribute('color', new THREE.BufferAttribute(particleColors, 3).setUsage(THREE.DynamicDrawUsage));


    // 初始化顯示數量
    particles.setDrawRange(0, particleCount);

    scene.add(new THREE.Points(particles, pMaterial));
}

// 粒子間的連線設定
function setupLines() {
    const geometry = new THREE.BufferGeometry();
    // 預留足夠空間給連線
    const linePositions = new Float32Array(MAX_PARTICLES * 60); // 增加緩衝空間防止溢出
    geometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));

    material = new THREE.LineBasicMaterial({
        color: 0xffffff, // 初始設定顏色
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending
    });

    const lineSegments = new THREE.LineSegments(geometry, material);
    scene.add(lineSegments);
}

// 動態視覺效果
function animate() {
    requestAnimationFrame(animate); // 粒子動態視覺
    if (!particles) return;

    const positions = particles.attributes.position.array;

    // 更新粒子位置與「邊界檢查」
    for (let i = 0; i < MAX_PARTICLES; i++) {
        const pData = particleData[i];
        positions[i * 3] += pData.velocity.x * currentSpeedFactor;
        positions[i * 3 + 1] += pData.velocity.y * currentSpeedFactor;
        positions[i * 3 + 2] += pData.velocity.z * currentSpeedFactor;

        // 這裡使用動態的 currentRange
        // 如果座標超過當前範圍，就反彈
        if (Math.abs(positions[i * 3]) > currentRange) pData.velocity.x *= -1;
        if (Math.abs(positions[i * 3 + 1]) > currentRange) pData.velocity.y *= -1;
        if (Math.abs(positions[i * 3 + 2]) > currentRange) pData.velocity.z *= -1;

        // 額外保險：如果範圍突然縮小，粒子被卡在外面，強制拉回
        if (positions[i * 3] > currentRange) positions[i * 3] = currentRange;
        if (positions[i * 3] < -currentRange) positions[i * 3] = -currentRange;
    }
    particles.attributes.position.needsUpdate = true;

    // 計算動態閃爍時間與透明度
    const time = performance.now() * 0.001; // 閃爍秒數
    const blinkSpeed = (1.5 + currentArousal * 5.0);  // 基礎頻率 1.5，情緒能量 a 越高閃越快 / 憤怒 (a=1) -> 頻率 4.5 (激烈放電) / 孤獨 (a=-0.8) -> 頻率 0.3 (緩慢呼吸)

    // 線條透明度變化
    material.opacity = 0.1 + Math.abs(Math.sin(time * blinkSpeed)) * 0.3;

    let lineIdx = 0;
    const lineMesh = scene.children.find(c => c instanceof THREE.LineSegments);
    const lineArray = lineMesh.geometry.attributes.position.array;
    const limit = Math.min(particleCount, 150); // 限制數量避免卡頓
    const dynamicDist = 150 + (Math.abs(currentArousal) * 100); // 基礎距離 150，當 a 為負數（難過）時，增加感應距離

    for (let i = 0; i < limit; i++) {
        for (let j = i + 1; j < limit; j++) {
            const dx = positions[i * 3] - positions[j * 3];
            const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
            const dz = positions[i * 3 + 2] - positions[j * 3 + 2];

            if (Math.sqrt(dx * dx + dy * dy + dz * dz) < dynamicDist && lineIdx < MAX_PARTICLES * 6) {

                // 設定點 A
                lineArray[lineIdx++] = positions[i * 3];
                lineArray[lineIdx++] = positions[i * 3 + 1];
                lineArray[lineIdx++] = positions[i * 3 + 2];

                // 設定點 B
                lineArray[lineIdx++] = positions[j * 3];
                lineArray[lineIdx++] = positions[j * 3 + 1];
                lineArray[lineIdx++] = positions[j * 3 + 2];
            }
        }
    }

    // 告訴 Three.js 有多少線
    lineMesh.geometry.setDrawRange(0, lineIdx / 3);
    lineMesh.geometry.attributes.position.needsUpdate = true;
    renderer.render(scene, camera);
}


function createCircleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
}

// 點擊事件
window.addEventListener('DOMContentLoaded', () => {
    // 尋找內文含有 "To access serial devices" 的按鈕或容器並刪除
    const buttons = document.querySelectorAll('button, div');
    buttons.forEach(el => {

        if (el.innerText && el.innerText.includes('To access serial devices')) {
            el.remove(); // 直接從 DOM 裡面刪除這個白色區塊！
        }
    });
});

window.addEventListener('click', async () => {
    if (typeof Tone !== 'undefined' && Tone.context.state !== 'running') {
        await Tone.start();
        console.log("AudioContext 已透過全域點擊成功啟動！");
    }
}, { once: true }); // once: true 代表只會觸發一次

init(); // 啟動程式
