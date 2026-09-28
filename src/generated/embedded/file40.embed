function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error("Operation aborted.");
}
function granted(status, kind) {
    return status[kind] === true;
}
function allGranted(status, kinds) {
    return kinds.every(({ kind }) => granted(status, kind));
}
function missingKinds(status, kinds) {
    return kinds.flatMap(({ kind }) => granted(status, kind) ? [] : [kind]);
}
export async function ensurePermissions(ctx, bridge, helperPath, signal) {
    let status = await bridge.checkPermissions(signal);
    if (allGranted(status, bridge.kinds))
        return status;
    if (!ctx.hasUI)
        throw new Error(bridge.copy.nonInteractiveError(helperPath));
    // Register before prompting so platform settings panes can already list
    // the helper and the user only has to enable existing entries.
    await bridge.registerPermissions(signal).catch(() => undefined);
    while (!allGranted(status, bridge.kinds)) {
        throwIfAborted(signal);
        const missing = missingKinds(status, bridge.kinds);
        const options = bridge.kinds
            .filter(({ kind }) => missing.includes(kind))
            .map(({ openOption }) => openOption);
        options.push("Recheck (restarts helper)", "Cancel");
        const choice = await ctx.ui.select(bridge.copy.prompt(status, helperPath, bridge.permissionHint), options, { signal });
        if (!choice || choice === "Cancel")
            throw new Error(bridge.copy.incompleteError(helperPath));
        const selected = bridge.kinds.find(({ openOption }) => choice === openOption);
        if (selected)
            await bridge.openPermissionPane(selected.kind, signal);
        if (choice.startsWith("Recheck")) {
            // Restart first: permission decisions can be cached by a running
            // helper process and remain stale after the user grants access.
            await bridge.restartHelper(signal);
            status = await bridge.checkPermissions(signal);
            if (allGranted(status, bridge.kinds)) {
                ctx.ui.notify(bridge.copy.readyMessage, "info");
            }
            else {
                ctx.ui.notify(bridge.copy.stillMissing(missingKinds(status, bridge.kinds)), "warning");
            }
        }
    }
    return status;
}
