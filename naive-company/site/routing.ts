/**
 * One app, two doors: the public site at `/` and the operator dashboard under `/app`. The dashboard
 * used to own the root, so an operator's bookmark or a studio link may still say `/crm`; those are
 * sent to `/app/crm`, from the dev server, the local server and — on a static deploy, where no
 * server sees them — by the public site's own first line of script.
 */
export const OPERATOR_PREFIX = "/app";

const LEGACY_OPERATOR = /^\/(crm|approvals|agents|clients|settings)(?=\/|$)/;

/** Where a pre-`/app` operator path now lives, or null when `pathname` is not one. */
export const operatorRedirect = (pathname: string): string | null =>
  LEGACY_OPERATOR.test(pathname) ? `${OPERATOR_PREFIX}${pathname}` : null;

/** True for `/app` and everything under it — the paths the operator bundle answers. */
export const isOperatorPath = (pathname: string): boolean =>
  pathname === OPERATOR_PREFIX || pathname.startsWith(`${OPERATOR_PREFIX}/`);
