export const PROCESS_MESSAGES = {
  label: 'Processing',
  legacy: 'Original',
  linear: 'Linear',
  unsupported: 'Unsupported photo processing version',
  missingSource: 'Linear processing requires a matching decoded source',
  video: 'Linear processing is available for still photos'
}

export function validateProcessVersion(value) {
  if (value !== 1 && value !== 2)
    throw Object.assign(new RangeError(PROCESS_MESSAGES.unsupported), { code: 'PROCESS_VERSION' })
  return value
}

export function processingVersion(recipe = {}) {
  return recipe.processVersion === undefined ? 1 : validateProcessVersion(recipe.processVersion)
}

export function neutralRecipe(recipe = {}) {
  processingVersion(recipe)
  return recipe.processVersion === undefined ? {} : { processVersion: recipe.processVersion }
}
