import { CATALOG_FLAG_VALUES, CATALOG_EDIT_VALUES, validateCatalogFilters } from './organization.js'

export const SMART_ALBUM_MESSAGES = {
  edit: 'Edit rules',
  title: 'Edit smart album',
  search: 'Search',
  rating: 'Minimum rating',
  flag: 'Flag',
  edited: 'Edit status',
  save: 'Save',
  cancel: 'Cancel',
  invalid: 'Provide search, minimum rating, flag and edit status for the smart album',
  notSmart: 'Choose a smart album',
  notFound: 'Album not found',
  local: 'Albums belong to the imported library; switch to Library first'
}

export const SMART_RATING_OPTIONS = [
  [0, 'All ratings'],
  ...[1, 2, 3, 4, 5].map((value) => [value, value + ' stars and up'])
]
export const SMART_FLAG_OPTIONS = CATALOG_FLAG_VALUES.map((value, index) => [
  value,
  ['All flags', 'Picked', 'Rejected', 'Unflagged'][index]
])
export const SMART_EDIT_OPTIONS = CATALOG_EDIT_VALUES.map((value, index) => [
  value,
  ['All edits', 'Edited', 'Unedited'][index]
])

const fields = ['text', 'rating', 'flag', 'edited']

export function validateSmartRule(rule) {
  if (
    !rule ||
    typeof rule !== 'object' ||
    Array.isArray(rule) ||
    Object.keys(rule).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(rule, key)) ||
    typeof rule.text !== 'string'
  )
    throw Error(SMART_ALBUM_MESSAGES.invalid)
  return { ...validateCatalogFilters(rule), text: rule.text }
}

export function sameSmartRule(a, b) {
  return fields.every((key) => a[key] === b[key])
}
