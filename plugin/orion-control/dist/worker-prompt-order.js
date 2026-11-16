export function workerSystemPrompt({ stable, card, perTurn, now }) {
    const cardPart = card.trim() ? `\n\n${card.trimEnd()}` : "";
    return `${stable}${cardPart}${perTurn.join("")}\n\n${now}`;
}
