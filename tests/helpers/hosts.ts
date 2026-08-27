/**
 * JS-side mirror of the grep -E hosts pattern in system/hosts.ts
 * (POSIX [[:space:]] classes → explicit spaces) so matching behavior is
 * testable without shelling out to grep.
 */
export function hasHostsEntryOffline(line: string, domain: string): boolean {
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[ \\t]*127\\.0\\.0\\.1[ \\t]+${escaped}([ \\t]|$)`).test(line);
}
