// Provider popup header helpers.
//
// The popup shows the plan next to the provider icon because the icon already
// identifies the provider. `showOrgName` only changes presentation: for
// Claude/Codex it removes the trailing "(workspace)" from Team/Business plan
// labels. Payloads, caches, and CLI output are never rewritten.

const ORG_PLAN_PROVIDERS = new Set(['claude', 'codex']);
const ORG_SUFFIX = /\s*\([^()]*\)\s*$/;

export function providerPlan(status, showOrgName = true) {
    const plan = status?.plan || status?.name || '';
    if (showOrgName || !ORG_PLAN_PROVIDERS.has(status?.key))
        return plan;
    return plan.replace(ORG_SUFFIX, '').trim();
}

export function providerUser(status, showUserInfo = true) {
    if (!showUserInfo)
        return '';
    return status?.user || '';
}
