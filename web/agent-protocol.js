import { controls } from './adjustments.js'
import { validCrop } from './geometry.js'
import { CROP_GUIDES } from './crop-guides.js'
import { COLOR_SPACES } from './color-spaces.js'
import { validateExportColorSpace } from './export-color.js'
import { LOCAL_CONTROLS, validateLocalTool, validateLocalChanges } from './local-tools.js'
import { EXPORT_TYPES } from './formats.js'
import { EXPORT_METADATA_POLICIES, validateExportMetadataPolicy } from './export-metadata.js'
import { OUTPUT_SHARPENING_LEVELS, validateOutputSharpening } from './export-sharpening.js'
import { AI_TARGETS } from './ai-models.js'
import { OPTICS_CONTROLS, validateOptics } from './optics.js'
import { validateDepthChanges } from './depth-effects.js'
import { CATALOG_FLAG_VALUES, CATALOG_EDIT_VALUES } from './organization.js'
import { validateSmartRule } from './smart-album-rule.js'

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const number = (description, minimum, maximum, extra = {}) => ({
  type: 'number',
  description,
  minimum,
  maximum,
  ...extra
})
const entry = (summary, properties = {}, required = [], extra = {}) => ({
  summary,
  parameters: { type: 'object', properties, required, additionalProperties: false },
  ...extra
})
const edits = Object.assign({}, ...Object.values(controls))
const pointRule = {
  type: 'object',
  description: 'Normalized original-image point, before crop/rotate/flip',
  properties: { x: number('Original x fraction', 0, 1), y: number('Original y fraction', 0, 1) },
  required: ['x', 'y'],
  additionalProperties: false
}
const localProperties = {
  type: string('Tool shape', {
    enum: [
      'linear',
      'radial',
      'brush',
      'semantic',
      'color-range',
      'luminance-range',
      'depth-range',
      'composite',
      'clone',
      'heal'
    ]
  }),
  color: string('sRGB reference color #RRGGBB'),
  tolerance: number('Color RMS sRGB distance accepted in full', 0, 1),
  softness: number('Range transition width', 0, 1),
  min: number('Minimum linear relative luminance', 0, 1),
  max: number('Maximum linear relative luminance', 0, 1),
  operation: string('Soft mask combination', { enum: ['add', 'subtract', 'intersect'] }),
  components: {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: { type: 'object' },
    description: 'Two mask component recipes; nested adjustments are ignored'
  },
  start: pointRule,
  end: pointRule,
  center: pointRule,
  source: pointRule,
  points: {
    type: 'array',
    description: 'Brush/repair stroke in original coordinates; at least one point',
    items: pointRule,
    minItems: 1
  },
  radius: number('Brush radius as a fraction of the original short edge', 0.00001, 1),
  rx: number('Ellipse x radius as original width fraction', 0.00001, 1),
  ry: number('Ellipse y radius as original height fraction', 0.00001, 1),
  opacity: number('Local effect strength', 0, 1),
  feather: number('Soft edge fraction; zero is hard', 0, 1),
  invert: { type: 'boolean', description: 'Invert mask coverage' },
  enabled: { type: 'boolean', description: 'Enable this local edit' },
  raster: {
    type: 'object',
    description: 'Normalized full-original soft mask, bilinearly sampled',
    properties: {
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      encoding: { type: 'string', enum: ['base64-u8'] },
      data: { type: 'string', description: 'Base64 grayscale samples in 0..255' }
    },
    required: ['width', 'height', 'encoding', 'data'],
    additionalProperties: false
  },
  provenance: { type: 'object', description: 'Model/source metadata for an external semantic raster' },
  adjustments: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(LOCAL_CONTROLS).map(([key, [min, max]]) => [key, number('Local ' + key, min, max)])
    ),
    additionalProperties: false
  }
}
const localDefinitions = {}
for (const kind of ['mask', 'repair']) {
  const properties = Object.fromEntries(
    Object.entries(localProperties).filter(([key]) =>
      kind === 'mask'
        ? key !== 'source'
        : ![
            'start',
            'end',
            'center',
            'rx',
            'ry',
            'invert',
            'adjustments',
            'raster',
            'provenance',
            'color',
            'tolerance',
            'softness',
            'min',
            'max',
            'operation',
            'components'
          ].includes(key)
    )
  )
  properties.type = {
    ...properties.type,
    enum:
      kind === 'mask'
        ? [
            'linear',
            'radial',
            'brush',
            'semantic',
            'color-range',
            'luminance-range',
            'depth-range',
            'composite'
          ]
        : ['clone', 'heal']
  }
  localDefinitions[kind + '.add'] = entry(
    'Add a non-destructive ' +
      (kind === 'mask'
        ? 'linear/radial/brush adjustment mask'
        : 'clone or mean-color matched texture repair'),
    { [kind]: { type: 'object', properties, required: ['type'], additionalProperties: false } },
    [kind]
  )
  localDefinitions[kind + '.update'] = entry(
    'Update local ' + kind + ' geometry, strength or adjustments',
    {
      id: string('Local tool ID from state'),
      changes: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'type')),
        additionalProperties: false
      }
    },
    ['id', 'changes']
  )
  localDefinitions[kind + '.remove'] = entry(
    'Remove a local ' + kind,
    { id: string('Local tool ID from state') },
    ['id']
  )
  for (const action of ['add', 'update', 'remove'])
    localDefinitions[kind + '.' + action].parameters.properties.photoId = string(
      'Optional selected-photo guard; rejects if selection has changed'
    )
}

// This command catalog is shared by offline CLI discovery and the live GUI agent.
export const definitions = {
  ...localDefinitions,
  cull: entry('Measure focus, clipped exposure and eye detail on selected or specified photos', {
    ids: { type: 'array', items: { type: 'string' } }
  }),
  'red-eye': entry('Correct excess red at detected eyes or a specified original-image point', {
    x: number('Original x', 0, 1),
    y: number('Original y', 0, 1),
    radius: number('Radius relative to short edge', 0.001, 0.5)
  }),
  enhance: entry(
    'Create a new 8-bit PNG from current edited raster using real local neural denoise or 3x luminance super resolution; not sensor RAW denoising',
    {
      mode: string('Neural operation', { enum: ['denoise', 'super-resolution'] }),
      strength: number('Blend strength', 0, 1),
      photoId: string('Optional selected-photo guard')
    }
  ),
  rename: entry(
    'Rename the selected imported library photo',
    { name: string('File name, including extension') },
    ['name']
  ),
  'capture-time': entry('Set capture time on selected photos', { time: string('ISO date and time') }, [
    'time'
  ]),
  purge: entry('Permanently remove the selected deleted library photos, releasing unreferenced originals'),
  'mask-overlay': entry(
    'Show, hide or toggle the selected mask coverage overlay without changing photo pixels',
    { enabled: { type: 'boolean', description: 'Omit to toggle' } }
  ),
  'local-select': entry(
    'Select a mask, repair, or nested mask component in the live editor',
    {
      id: string('Root adjustment ID, or an empty string to clear selection'),
      path: {
        type: 'array',
        items: { type: 'integer', enum: [0, 1] },
        description: 'Child indices inside a composite mask'
      },
      photoId: string('Optional selected-photo guard')
    },
    ['id']
  ),
  'mask-preview': entry(
    'Export the true selected mask coverage after crop/rotation/optics; excludes image adjustments',
    {
      id: string('Mask ID; defaults to selected or most recently added mask'),
      style: string('PNG coverage channels', { enum: ['gray', 'rgba'] }),
      maxSize: { type: 'integer', minimum: 1, description: 'Optional maximum output edge' }
    },
    [],
    { returns: 'image/png' }
  ),
  'library-undo': entry('Undo the last library organization or import action'),
  'library-redo': entry('Reapply an undone library organization action'),
  'history-undo': entry(
    'Undo the most recent library or active-photo change in Grid; undo the active photo edit in Detail or Local'
  ),
  'history-redo': entry(
    'Redo the most recently undone library or active-photo change in Grid; redo the active photo edit in Detail or Local'
  ),
  clipping: entry('Toggle highlight and shadow clipping indicators in the workspace'),
  'point-tool': entry('Activate the point color eyedropper'),
  'sample-color': entry(
    'Sample RGB from normalized coordinates of the edited photo',
    { x: number('Horizontal position', 0, 1), y: number('Vertical position', 0, 1) },
    ['x', 'y']
  ),
  'range-color': entry(
    'Sample the decoded original sRGB display color and fill or refine a color range',
    {
      x: number('Normalized original-image x, before optics/crop/rotation/flip', 0, 1),
      y: number('Normalized original-image y, before optics/crop/rotation/flip', 0, 1),
      photoId: string('Optional current-photo guard'),
      id: string(
        'Mask/repair root ID; omit for current selection or use an empty string for a new range draft'
      ),
      path: {
        type: 'array',
        items: { type: 'integer', enum: [0, 1] },
        description: 'Nested component path for an explicit root ID'
      }
    },
    ['x', 'y']
  ),
  'point-add': entry('Add a point color sample', { color: string('sRGB hex color') }, ['color']),
  'point-update': entry(
    'Adjust pixels near a sampled color',
    {
      id: string('Sample ID'),
      hue: number('Hue shift in degrees', -180, 180),
      saturation: number('Saturation shift', -100, 100),
      luminance: number('Luminance shift', -100, 100),
      range: number('Selection range', 0, 100)
    },
    ['id']
  ),
  'point-remove': entry('Remove a color sample', { id: string('Sample ID') }, ['id']),
  'depth-estimate': entry(
    'Estimate and persist real local relative inverse depth; downloads fixed 27 MB Apache-2.0 model once',
    { photoId: string('Optional selected-photo guard') }
  ),
  'depth-range': entry('Create an adjustment mask from inferred relative inverse depth; 0 far, 1 near', {
    min: number('Depth minimum', 0, 1),
    max: number('Depth maximum', 0, 1),
    softness: number('Range transition', 0, 1),
    adjustments: localProperties.adjustments,
    photoId: string('Optional selected-photo guard')
  }),
  'lens-blur': entry(
    'Apply real depth-guided near/far blur around an adjustable focus interval; relative depth is not metres',
    {
      enabled: { type: 'boolean' },
      amount: number('Blur radius as original short-edge fraction', 0, 0.15),
      min: number('Focus far boundary', 0, 1),
      max: number('Focus near boundary', 0, 1),
      softness: number('Depth transition to full defocus', 0, 1),
      photoId: string('Optional selected-photo guard')
    }
  ),
  'remove-mask': entry('Inpaint a masked area from surrounding pixels', {
    id: string('Mask ID; defaults to most recent'),
    algorithm: string('Inpainting method', { enum: ['ns', 'telea'] }),
    radius: number('Neighborhood radius in original pixels', 0.1, 100)
  }),
  preferences: entry(
    'Read or update workspace preferences',
    Object.fromEntries(
      ['autoAdvance', 'filenames', 'extensions', 'shortcuts'].map((key) => [key, { type: 'boolean' }])
    )
  ),
  label: entry(
    'Set a color label on the selected photos',
    { value: string('Empty clears the color', { enum: ['', 'red', 'yellow', 'green', 'blue', 'purple'] }) },
    ['value']
  ),
  'lens-profiles': entry('List the bundled licensed Lensfun rectilinear profiles', {
    query: string('Optional maker/model search')
  }),
  'lens-match': entry('Find exact EXIF camera/lens candidates without applying or inventing a calibration'),
  'lens-apply': entry(
    'Apply a calibrated Lensfun profile at the actual focal length',
    {
      id: string('Profile ID from lens-profiles or lens-match'),
      focal: number('Actual focal length in millimeters', 0.001, Number.MAX_VALUE),
      cropFactor: number(
        'Actual camera crop factor; inferred from an exact camera match where possible',
        0.001,
        Number.MAX_VALUE
      ),
      photoId: string('Optional selected-photo identity guard')
    },
    ['id']
  ),
  optics: entry(
    'Update manual lens and projective geometry correction on the active photo',
    {
      changes: {
        type: 'object',
        description: 'Manual lens/geometry parameters and calibrated-profile switches',
        properties: {
          ...Object.fromEntries(
            Object.entries(OPTICS_CONTROLS).map(([key, { range }]) => [key, number(key, range[0], range[1])])
          ),
          enabled: { type: 'boolean' },
          profileDistortion: { type: 'boolean' },
          profileTCA: { type: 'boolean' }
        }
      },
      photoId: string('Optional selected-photo identity guard')
    },
    ['changes']
  ),
  'optics-reset': entry('Remove lens and perspective corrections while retaining other edits', {
    photoId: string('Optional selected-photo identity guard')
  }),
  straighten: entry(
    'Solve rotation from two original-image points on a horizontal or vertical reference',
    {
      start: pointRule,
      end: pointRule,
      axis: string('Desired line axis', { enum: ['horizontal', 'vertical'] }),
      photoId: string('Optional selected-photo identity guard')
    },
    ['start', 'end']
  ),
  'straighten-tool': entry('Choose two image points in the GUI for an actual straightening reference', {
    axis: string('Reference line axis', { enum: ['horizontal', 'vertical'] })
  }),
  'mask.combine': entry(
    'Combine two mask coverages into one group; retain first adjustments and consume second mask',
    {
      id: string('First mask ID'),
      operandId: string('Second mask ID'),
      operation: string('Coverage operation', { enum: ['add', 'subtract', 'intersect'] }),
      photoId: string('Optional selected-photo guard')
    },
    ['id', 'operandId', 'operation']
  ),
  'mask.component-update': entry(
    'Edit component coverage inside a composite mask; adjustments remain on its group',
    {
      id: string('Composite mask ID'),
      path: {
        type: 'array',
        items: { type: 'integer', enum: [0, 1] },
        minItems: 1,
        description: 'Nested zero/one child indexes'
      },
      changes: { type: 'object', description: 'Same coverage changes as mask.update; no adjustments' },
      photoId: string('Optional selected-photo guard')
    },
    ['id', 'path', 'changes']
  ),
  'grid-layout': entry(
    'Set the library grid layout',
    { layout: string('Layout', { enum: ['square', 'mosaic'] }) },
    ['layout']
  ),
  'select-inverse': entry('Invert selection in the current view'),
  'virtual-copy': entry('Create a separate edit recipe sharing the original library file'),
  'save-frame': entry('Save the current edited video frame as a library photo'),
  stack: entry('Group selected library photos into a stack'),
  'stack-cover': entry('Use the selected photo as the stack cover'),
  'stack-toggle': entry('Expand or collapse the active stack'),
  unstack: entry('Ungroup the current stack'),
  'auto-stack': entry('Group library images by capture interval or visual similarity', {
    by: string('Grouping method', { enum: ['time', 'similarity'] }),
    threshold: {
      type: 'number',
      minimum: 0,
      description: 'Seconds, or normalized RGB difference for similarity'
    }
  }),
  slideshow: entry('Start or stop a slideshow through the current view', {
    seconds: number('Seconds per photo', 0.2, 3600),
    stop: { type: 'boolean' }
  }),
  'video-play': entry('Play the selected clip in detail view'),
  'video-pause': entry('Pause video playback'),
  'video-seek': entry('Seek to a frame in seconds', { time: { type: 'number', minimum: 0 } }, ['time']),
  'video-trim': entry(
    'Set nondestructive in and out points in seconds',
    { start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 } },
    ['start', 'end']
  ),
  'ai-mask': entry(
    'Run real local semantic segmentation and add a soft adjustment mask; sky downloads a fixed 172 MB model once',
    {
      target: string('Semantic selection', { enum: AI_TARGETS }),
      photoId: string('Optional selected-photo guard'),
      adjustments: localProperties.adjustments
    },
    ['target']
  ),
  'apply-xmp': entry('Apply an XMP sidecar to the active photo', { xml: string('XMP RDF/XML document') }, [
    'xml'
  ]),
  sync: entry(
    'Synchronize the imported library with an explicitly selected WebDAV folder',
    {
      endpoint: string('HTTPS WebDAV folder URL'),
      username: string('Optional username'),
      password: string('Optional password'),
      prefer: string('Resolve conflicting records in favor of one side', { enum: ['', 'local', 'remote'] })
    },
    ['endpoint']
  ),
  state: entry('Read the current GUI selection, visible photos, edit recipes and albums', {
    summary: { type: 'boolean', description: 'Return selection, count and current photo metadata only' }
  }),
  photos: entry('Page through compact visible photo metadata', {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 }
  }),
  import: entry(
    'Import image files into the live catalog',
    {
      files: {
        type: 'array',
        description: 'CLI paths become File objects in the GUI',
        items: { type: 'string' }
      }
    },
    ['files']
  ),
  'local-folders': entry('List previously authorized photo folders without importing originals'),
  'local-subfolders': entry(
    'Include or exclude descendants in the current local folder view',
    { enabled: { type: 'boolean' } },
    ['enabled']
  ),
  'local-open': entry('Choose a folder in the desktop dialog or reopen an authorized folder ID', {
    recursive: { type: 'boolean', description: 'Include photos in descendant folders' },
    root: string('Authorized folder ID from local-folders; omit to choose with the system dialog'),
    relative: string('Relative subfolder inside the authorized root')
  }),
  'local-browse': entry(
    'Browse a subfolder of the current authorized local root',
    { relative: string('Relative subfolder, or . for the root') },
    ['relative']
  ),
  library: entry('Return to the imported photo library'),
  'migrate-lrcat': entry('Open the Classic catalog migration workflow; no library is scanned automatically'),
  'migrate-apple-photos': entry(
    'Open migration instructions for an explicitly exported Apple Photos originals folder'
  ),
  'migration-scan': entry(
    'Read an explicitly chosen Classic SQLite catalog without opening its referenced originals',
    {
      catalog: {
        oneOf: [{ type: 'string' }, { type: 'object' }],
        localFile: true,
        description: 'Local .lrcat path in CLI; browser File or encoded file payload'
      }
    },
    ['catalog']
  ),
  'migration-folder': entry('Choose and authorize an originals/export folder in the native system picker'),
  'migration-apple-scan': entry(
    'List supported originals and XMP in an explicitly authorized Apple Photos export folder',
    { root: string('Authorized folder ID') },
    ['root']
  ),
  'migration-map': entry(
    'Map one catalog root to a reviewed authorized originals folder',
    {
      id: string('Migration plan ID'),
      sourceRoot: string('Source root ID from scan'),
      root: string('Authorized folder ID; omitted opens system picker'),
      prefix: string('Optional relative directory inside that folder')
    },
    ['id', 'sourceRoot']
  ),
  'migration-inspect': entry(
    'Stat only catalog-listed paths and report available, missing, unmapped and incomplete originals',
    { id: string('Saved migration plan ID') },
    ['id']
  ),
  'migration-commit': entry(
    'Migrate available referenced originals, metadata and static collections; retain retryable missing records',
    { id: string('Saved migration plan ID') },
    ['id']
  ),
  'migration-retry': entry(
    'Retry a saved migration without duplicating photos or overwriting their edits',
    { id: string('Saved migration plan ID') },
    ['id']
  ),
  'migration-report': entry('Read saved scan/report summaries', {
    id: string('Optional saved migration plan ID')
  }),
  'external-editor': entry('Choose an installed image editor, or use detected Photoshop', {
    photoshop: { type: 'boolean', description: 'Detect Photoshop instead of opening the editor picker' }
  }),
  'external-edit': entry(
    'Send an edited TIFF copy to the configured external editor; originals stay unchanged'
  ),
  'external-check': entry('Import stable saved external copies as new derived library photos'),
  tether: entry('Open the tethered capture panel and discover connected still cameras'),
  'camera-list': entry('Discover actual WIA or gphoto2 still cameras and report backend availability'),
  'camera-capture': entry(
    'Trigger the selected supported camera, keep camera originals, and import downloaded photos',
    { id: string('Camera ID from camera-list') },
    ['id']
  ),
  'share-configure': entry(
    'Configure a self-hosted OpenLR review server',
    { endpoint: string('Review server HTTP(S) URL'), token: string('Server administrator bearer token') },
    ['endpoint', 'token']
  ),
  'share-publish': entry(
    'Publish edited JPEG previews of a selected library album to the configured review server',
    {
      album: string('Album ID; defaults to the current album scope'),
      comments: { type: 'boolean', description: 'Allow review comments' },
      likes: { type: 'boolean', description: 'Allow reviewer likes' }
    }
  ),
  'share-reviews': entry('Read shared album comments and likes into the current GUI', {
    album: string('Album ID; defaults to current scope')
  }),
  'share-revoke': entry('Revoke a shared album secret link', {
    album: string('Album ID; defaults to current scope')
  }),
  select: entry(
    'Select a photo in the current view',
    {
      id: string('Photo ID from state'),
      toggle: { type: 'boolean', description: 'Toggle membership in the selection' },
      range: { type: 'boolean', description: 'Select the visible range from the selection anchor' }
    },
    ['id']
  ),
  'select-many': entry(
    'Select an explicit list of visible photo IDs; an empty array clears selection',
    { ids: { type: 'array', items: { type: 'string' }, description: 'Visible photo IDs' } },
    ['ids']
  ),
  'select-all': entry('Select every photo in the current filtered view'),
  'merge-hdr': entry(
    'Align selected original exposure brackets, recover calibrated linear radiance, and create a tone-mapped library photo',
    {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional ordered source IDs; defaults to the current selection'
      },
      evs: {
        type: 'array',
        items: { type: 'number' },
        description:
          'Brightness offsets in stops, one per source; defaults to exposure time/aperture/ISO EXIF'
      },
      align: {
        type: 'boolean',
        description: 'Auto align; set false only for fixed, identically framed tripod images'
      }
    }
  ),
  'merge-panorama': entry(
    'Register overlapping originals with ORB/RANSAC and create a projective feather-blended library panorama',
    {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional ordered source IDs; defaults to the current selection'
      }
    }
  ),
  'export-hdr': entry(
    'Export selected HDR merge as scene-linear Radiance RGBE, before subsequent display edits',
    {},
    [],
    { returns: 'image/vnd.radiance' }
  ),
  view: entry(
    'Switch between grid and detail editing',
    {
      inspector: { type: 'boolean', description: 'Show editing controls in detail' },
      mode: string('Workspace view', { enum: ['grid', 'detail'] })
    },
    ['mode']
  ),
  scope: entry(
    'Show all, flagged, deleted, or an album',
    { id: string('all, picked, trash, or an album ID') },
    ['id']
  ),
  search: entry(
    'Filter photos by filename and keywords',
    { text: string('Search text; empty clears the filter') },
    ['text']
  ),
  sort: entry(
    'Sort the visible photographs',
    {
      order: string('Sort order', { enum: ['recent', 'name', 'rating', 'capture', 'focus'] }),
      direction: string('Sort direction; default name ascending, other orders descending', {
        enum: ['asc', 'desc']
      })
    },
    ['order']
  ),
  filter: entry('Filter the current scope by minimum rating, flag, and edit status', {
    rating: number('Minimum star rating', 0, 5, { type: 'integer' }),
    flag: string('Flag filter', { enum: CATALOG_FLAG_VALUES }),
    edited: string('Edit status filter', { enum: CATALOG_EDIT_VALUES })
  }),
  album: entry(
    'Create an album',
    {
      name: string('Nonempty album name'),
      smart: { type: 'boolean', description: 'Use current search and filters as a live album rule' }
    },
    ['name']
  ),
  'album-rename': entry('Rename an album', { id: string('Album ID'), name: string('New nonempty name') }, [
    'id',
    'name'
  ]),
  'album-rule': entry(
    'Replace a smart album’s saved criteria without changing the current view filters',
    {
      id: string('Smart album ID from state'),
      rule: {
        type: 'object',
        description: 'Complete replacement of the saved search and filter criteria',
        properties: {
          text: string('Search text, matched case-insensitively as in the catalog'),
          rating: number('Minimum star rating', 0, 5, { type: 'integer' }),
          flag: string('Flag filter', { enum: CATALOG_FLAG_VALUES }),
          edited: string('Edit status filter', { enum: CATALOG_EDIT_VALUES })
        },
        required: ['text', 'rating', 'flag', 'edited'],
        additionalProperties: false
      }
    },
    ['id', 'rule']
  ),
  'album-delete': entry(
    'Delete an album while retaining its photos and other memberships',
    { id: string('Album ID') },
    ['id']
  ),
  membership: entry(
    'Toggle selected photo membership in an album',
    { album: string('Album ID from state') },
    ['album']
  ),
  rate: entry(
    'Set the selected photo star rating',
    { value: number('Star rating', 0, 5, { type: 'integer' }), advance: { type: 'boolean' } },
    ['value']
  ),
  flag: entry(
    'Set picked, rejected, or unflagged',
    {
      value: string('Empty string clears the flag', { enum: ['pick', 'reject', ''] }),
      advance: { type: 'boolean' }
    },
    ['value']
  ),
  keywords: entry('Set keywords on the selected photo', { value: string('Keywords text') }, ['value']),
  delete: entry('Move the selected photo to Deleted without removing its original'),
  restore: entry('Restore the selected photo from Deleted'),
  'copy-edits': entry('Copy active-photo edits for pasting to the selected group', {
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional edit keys to copy; omit for the entire recipe'
    }
  }),
  'paste-edits': entry('Paste copied edits to every selected photo, with per-photo undo'),
  'version-save': entry(
    'Save a named immutable edit snapshot on the active photo',
    { name: string('Version name') },
    ['name']
  ),
  'version-restore': entry(
    'Restore a saved version on the active photo',
    { id: string('Version ID from state') },
    ['id']
  ),
  'version-rename': entry(
    'Rename a saved version on the active photo',
    { id: string('Version ID'), name: string('New name') },
    ['id', 'name']
  ),
  'version-delete': entry(
    'Delete a saved version without changing current edits',
    { id: string('Version ID') },
    ['id']
  ),
  edit: entry(
    'Change one non-destructive adjustment, crop, rotation or flip',
    {
      key: string('Case-sensitive adjustment key', {
        enum: [...Object.keys(edits), 'turn', 'flip', 'aspect', 'crop']
      }),
      value: {
        description:
          'Adjustment number, turn 0..3, flip boolean, aspect string, or normalized crop {x,y,w,h} (null clears)',
        oneOf: [
          { type: 'number' },
          { type: 'boolean' },
          { type: 'string' },
          { type: 'object' },
          { type: 'null' }
        ]
      }
    },
    ['key', 'value'],
    {
      editControls: edits,
      specialControls: {
        turn: [0, 1, 2, 3],
        flip: [true, false],
        aspect: ['', '1', '1.5', '1.7777777778', '0.8']
      }
    }
  ),
  'compare-pair': entry('Show original and edited images side by side'),
  'sample-tool': entry('Toggle white balance sampler'),
  'white-balance': entry(
    'Neutralize a patch at normalized original-image coordinates',
    { x: number('Horizontal position', 0, 1), y: number('Vertical position', 0, 1) },
    ['x', 'y']
  ),
  fullscreen: entry('Toggle the desktop window fullscreen state'),
  panel: entry(
    'Open or close a workspace panel',
    {
      name: string('Panel title or photos for navigation'),
      open: { type: 'boolean', description: 'Requested open state for editing panels' }
    },
    ['name']
  ),
  'local-tool': entry(
    'Activate a local editing tool',
    {
      tool: string('Tool', { enum: ['off', 'brush', 'linear', 'radial', 'clone', 'heal', 'color-sample'] }),
      photoId: string('Optional current-photo guard')
    },
    ['tool']
  ),
  screenshot: entry('Capture the visible desktop workspace as a PNG', {}, [], { returns: 'image/png' }),
  presets: entry('List built-in and saved adjustment presets'),
  'preset-save': entry('Save global adjustments as a reusable preset', { name: string('Preset name') }, [
    'name'
  ]),
  'preset-apply': entry('Apply a preset to the selected photo', { id: string('Preset ID') }, ['id']),
  'preset-delete': entry('Delete a saved preset', { id: string('Preset ID') }, ['id']),
  histogram: entry('Return RGB and luminance bin counts sampled from the current edited image'),
  'auto-tone': entry('Set exposure using the median luminance of the original'),
  'crop-tool': entry('Open the crop rectangle tool, or commit a drawn rectangle'),
  'crop-guide': entry(
    'Set view-only composition guides; does not change photo edits or exports',
    {
      type: string('Composition guide', { enum: Object.keys(CROP_GUIDES) }),
      orientation: number('Mirror asymmetric guides: 0 default, 1 horizontal, 2 vertical, 3 both', 0, 3, {
        type: 'integer'
      })
    },
    ['type']
  ),
  'crop-nudge': entry(
    'Move the open crop draft by preview pixels',
    {
      dx: { type: 'integer', description: 'Horizontal preview pixels, positive to the right' },
      dy: { type: 'integer', description: 'Vertical preview pixels, positive downward' }
    },
    ['dx', 'dy']
  ),
  'crop-cancel': entry('Discard the uncommitted crop rectangle'),
  'crop-drag': entry(
    'Draw, move, or resize the open crop draft on the optics-corrected canvas',
    {
      grip: string('Rectangle handle or gesture', {
        enum: ['new', 'move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      }),
      x1: number('Starting horizontal fraction', 0, 1),
      y1: number('Starting vertical fraction', 0, 1),
      x2: number('Ending horizontal fraction', 0, 1),
      y2: number('Ending vertical fraction', 0, 1),
      lockAspect: { type: 'boolean', description: 'Constrain proportions as with Shift-drag' }
    },
    ['grip', 'x1', 'y1', 'x2', 'y2']
  ),
  processing: entry(
    'Choose the selected still photo processing version',
    {
      version: { type: 'integer', enum: [1, 2], description: '1: original processing, 2: linear processing' },
      photoId: string('Optional selected-photo guard')
    },
    ['version']
  ),
  reset: entry('Reset all selected-photo edits, retaining its processing version'),
  undo: entry('Undo an edit on the selected photo in the current GUI session'),
  redo: entry('Redo an edit on the selected photo in the current GUI session'),
  compare: entry('Toggle the original image comparison in detail view'),
  film: entry('Toggle the detail-view filmstrip'),
  zoom: entry('Toggle fit versus full-resolution detail view'),
  preview: entry(
    'Read the current edited or comparison image as PNG',
    { maxSize: { type: 'integer', minimum: 1, description: 'Maximum image edge in pixels' } },
    [],
    { returns: 'image/png' }
  ),
  'export-previous': entry('Export the current photo or video using its remembered export settings', {}, [], {
    returns: 'image'
  }),
  'export-settings': entry(
    'Read remembered photo/video export settings, or replace one media slot explicitly',
    {
      media: string('Settings slot', { enum: ['photo', 'video'] }),
      options: {
        type: 'object',
        description: 'Export options using the same fields as export; provide media with options'
      }
    }
  ),
  export: entry(
    'Export selected photo bytes without opening a native save dialog',
    {
      format: string('Image format', { enum: EXPORT_TYPES }),
      maxSize: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description: 'Longest edge in pixels. Defaults to original size.'
      },
      watermark: string('Optional text at lower right'),
      metadata: string('Photo metadata to include in rendered output', { enum: EXPORT_METADATA_POLICIES }),
      outputSharpening: string('Sharpen the rendered photo at its final output size', {
        enum: OUTPUT_SHARPENING_LEVELS
      }),
      colorSpace: string('Output RGB encoding for JPEG, PNG, TIFF, AVIF and JPEG XL', {
        enum: Object.keys(COLOR_SPACES)
      }),
      quality: number('JPEG/AVIF/JPEG XL quality; 1 selects lossless AVIF/JXL', 0, 1)
    },
    [],
    { returns: 'image' }
  )
}

definitions['export-selection'] = entry(
  'Export the selected visible group sequentially to a folder, preserving the active editor',
  {
    ...definitions.export.parameters.properties,
    ids: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Visible photo IDs; defaults to the selected group in display order'
    },
    previous: {
      type: 'boolean',
      description: 'Use each media type’s last completed settings instead of new export options'
    },
    outputDirectory: string('Destination folder; omitted opens the folder chooser')
  },
  []
)
definitions['export-status'] = entry(
  'Read the latest export job, including progress and completed files, without waiting for the editor queue'
)
definitions['export-cancel'] = entry(
  'Request cancellation of the identified export job at the next safe checkpoint',
  {
    id: string('Job ID returned by export-status; prevents cancelling a later job')
  },
  ['id']
)

export const commands = Object.fromEntries(
  Object.entries(definitions).map(([name, definition]) => [
    name,
    Object.entries(definition.parameters.properties)
      .map(
        ([key, p]) =>
          key +
          (definition.parameters.required.includes(key) ? '' : '?') +
          ': ' +
          (p.enum?.join('|') ?? p.type ?? 'value')
      )
      .join(', ')
  ])
)

export function schema(command) {
  if (!Object.hasOwn(definitions, command)) throw new Error('Unknown command: ' + command)
  return { command, ...definitions[command] }
}

export function searchCommands(query, catalog = definitions) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(catalog)
    .map(([command, definition]) => ({
      command,
      summary: definition.summary,
      score: words.reduce(
        (score, word) =>
          score +
          (command === word
            ? 5
            : command.includes(word)
              ? 3
              : JSON.stringify(definition).toLowerCase().includes(word)
                ? 1
                : 0),
        0
      )
    }))
    .filter((item) => item.score || words.length === 0)
    .sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))
    .slice(0, 5)
    .map(({ score, ...item }) => item)
}

export function validateArgs(command, args) {
  const { parameters } = schema(command)
  if (!args || Array.isArray(args) || typeof args !== 'object')
    throw new Error('Arguments must be a JSON object')
  for (const required of parameters.required)
    if (!Object.hasOwn(args, required)) throw new Error('Missing argument: ' + required)
  for (const [key, value] of Object.entries(args)) {
    const rule = parameters.properties[key]
    if (!rule) throw new Error('Unknown argument: ' + key)
    if (rule.type === 'array' && !Array.isArray(value)) throw new Error(key + ' must be an array')
    if (
      rule.type &&
      rule.type !== 'array' &&
      (rule.type === 'integer' ? !Number.isInteger(value) : typeof value !== rule.type)
    )
      throw new Error(key + ' must be ' + rule.type)
    if (rule.enum && !rule.enum.includes(value))
      throw new Error(key + ' must be one of ' + JSON.stringify(rule.enum))
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || value < rule.minimum || value > rule.maximum)
    )
      throw new Error(key + ' is outside its valid range')
    if (rule.oneOf && !rule.oneOf.some((choice) => typeof value === choice.type))
      throw new Error('Invalid value for ' + key)
  }
  if (
    command === 'range-color' &&
    args.path !== undefined &&
    (args.id === undefined || args.path.some((index) => index !== 0 && index !== 1))
  )
    throw Error('A component path requires a root ID and zero/one indexes')
  if (command === 'album-rule') validateSmartRule(args.rule)
  if (command === 'export' && args.format !== undefined) {
    validateExportColorSpace(args.format, args.colorSpace)
    validateExportMetadataPolicy(args.format, args.metadata)
    validateOutputSharpening(args.format, args.outputSharpening)
  }
  if (command === 'export-settings') {
    if (Object.hasOwn(args, 'media') !== Object.hasOwn(args, 'options'))
      throw Error('Provide media and options together')
    if (args.options !== undefined) validateArgs('export', args.options)
  }
  if (command === 'edit') {
    const { key, value } = args
    if (Object.hasOwn(edits, key)) {
      const [minimum, maximum] = edits[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
        throw new Error(key + ' must be between ' + minimum + ' and ' + maximum)
    } else if (key === 'crop') {
      if (value !== null && !validCrop(value)) throw Error('Invalid crop rectangle')
    } else if (!definitions.edit.specialControls[key]?.includes(value))
      throw new Error('Invalid value for ' + key)
  }
  if (command === 'mask.add' || command === 'repair.add')
    validateLocalTool(command.split('.')[0], args[command.split('.')[0]])
  if (command === 'mask.update' || command === 'repair.update')
    validateLocalChanges(command.split('.')[0], args.changes)
  if (command === 'local-select' && args.path?.some((index) => index !== 0 && index !== 1))
    throw Error('Invalid component path')
  if (command === 'mask.component-update') {
    validateLocalChanges('mask', args.changes)
    if (!args.path.length || args.path.some((value) => value !== 0 && value !== 1))
      throw Error('Invalid component path')
    if (args.changes.adjustments) throw Error('Adjustments belong to the composite group')
  }
  if (command === 'ai-mask' && args.adjustments !== undefined)
    validateLocalChanges('mask', { adjustments: args.adjustments })
  if (command === 'depth-range' && args.adjustments !== undefined)
    validateLocalChanges('mask', { adjustments: args.adjustments })
  if (command === 'lens-blur')
    validateDepthChanges(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'photoId')))
  if (command === 'optics') validateOptics(args.changes)
  return args
}
