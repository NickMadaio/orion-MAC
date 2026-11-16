const busyNow = (isBusy) => { try {
    return isBusy();
}
catch {
    return true;
} };
export function createWarmAfterTurn(warm, { delayMs = 20_000, minGapMs = 60_000, isBusy = () => false } = {}) {
    let timer;
    let lastRun = Number.NEGATIVE_INFINITY;
    const fire = () => {
        timer = undefined;
        if (Date.now() - lastRun < minGapMs || busyNow(isBusy))
            return;
        lastRun = Date.now();
        try {
            Promise.resolve(warm()).catch(() => undefined);
        }
        catch { /* warming never touches a turn */ }
    };
    return {
        turnEnded() {
            try {
                if (timer)
                    clearTimeout(timer);
                timer = setTimeout(fire, delayMs);
                timer.unref?.();
            }
            catch { /* never throws into the hook that called it */ }
        },
    };
}
