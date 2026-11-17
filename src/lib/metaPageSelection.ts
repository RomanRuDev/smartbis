export function shouldShowConnectPage(
  selectedPageId: string | undefined,
  connectedPageId: string | undefined,
): boolean {
  return Boolean(selectedPageId && selectedPageId !== connectedPageId)
}
