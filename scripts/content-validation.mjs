export function assertUniqueIds(items, field, label) {
  const values = items.map((item) => item[field]);
  if (!values.every((value) => typeof value === "string" && value.trim())) {
    throw new Error(`Content validation failed: ${label} IDs must be non-empty strings`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`Content validation failed: ${label} IDs must be unique`);
  }
}
