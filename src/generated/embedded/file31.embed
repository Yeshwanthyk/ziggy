export function toBoolean(value) {
    return value === true || value === "true" || value === 1;
}
export function toFiniteNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
export function toOptionalString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
