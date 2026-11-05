import { controls } from './adjustments.js'

export const COPY_MESSAGES = {
  choose: 'Choose edits…',
  title: 'Choose edits to copy',
  all: 'All',
  none: 'None',
  cancel: 'Cancel',
  copy: 'Copy',
  changedPhoto: 'The active photo changed. Choose edits again.'
}

export const COPY_GROUPS = [
  ...Object.entries(controls).map(([label, values]) => ({
    id: label.toLowerCase().replaceAll(' ', '-'),
    label,
    keys: Object.keys(values)
  })),
  { id: 'point-colors', label: 'Point color', keys: ['pointColors'] },
  { id: 'crop', label: 'Crop and rotation', keys: ['crop', 'aspect', 'turn', 'flip'] },
  { id: 'optics', label: 'Optics and geometry', keys: ['optics'] },
  { id: 'local-tools', label: 'Masks, repairs and lens blur', keys: ['localTools'] },
  { id: 'fill', label: 'Content-aware removal', keys: ['fills'] },
  { id: 'red-eye', label: 'Red-eye correction', keys: ['redEyes'] },
  { id: 'video-trim', label: 'Video trim', keys: ['trim'] },
  { id: 'processing', label: 'Processing version', keys: ['processVersion'] }
]
