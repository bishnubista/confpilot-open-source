export function toContractDateTime(value: string) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
