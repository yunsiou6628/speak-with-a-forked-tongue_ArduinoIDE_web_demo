// interaction.js 情緒引擎-情緒轉譯器參數

import * as THREE from 'three';
/* 情緒互動核心轉譯器 */
export function handleInteraction(selectedText, emotionPool = []) {
    if (!selectedText || !emotionPool.length) return null;

    const selectedEmotion = emotionPool.find(item => item.text.outerText === selectedText);
    if (!selectedEmotion) return null;

    const speedFactor = 0.5 + (Math.abs(selectedEmotion.visual.a) * 1.5);
    const newCount = Math.max(40, 250 + (selectedEmotion.visual.v * 120));
    const defaultNotes = ["C4", "E4", "G4"];
    // 打包【視覺 + 聲音】一次回傳！
    return {
        ...selectedEmotion,
        visual: {
            ...selectedEmotion.visual,
            // 運算 Three.js 粒子系統參數
            speedFactor,
            newCount,
        },
        music: {
            ...selectedEmotion.music,
            notes: selectedEmotion.music?.notes?.length
                ? selectedEmotion.music.notes
                : defaultNotes,
        },
    }
}
