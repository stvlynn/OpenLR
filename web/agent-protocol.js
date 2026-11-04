import {controls} from './render.js'
import {validCrop} from './geometry.js'
import {LOCAL_CONTROLS,validateLocalTool,validateLocalChanges} from './local-tools.js'
import {EXPORT_TYPES} from './formats.js'
import {AI_TARGETS} from './ai-models.js'

const string = (description, extra={}) => ({type:'string', description, ...extra})
const number = (description, minimum, maximum, extra={}) => ({type:'number', description, minimum, maximum, ...extra})
const entry = (summary, properties={}, required=[], extra={}) => ({summary, parameters:{type:'object', properties, required, additionalProperties:false}, ...extra})
const edits=Object.assign({},...Object.values(controls))
const pointRule={type:'object',description:'Normalized original-image point, before crop/rotate/flip',properties:{x:number('Original x fraction',0,1),y:number('Original y fraction',0,1)},required:['x','y'],additionalProperties:false}
const localProperties={
  type:string('Tool shape',{enum:['linear','radial','brush','semantic','clone','heal']}),
  start:pointRule,end:pointRule,center:pointRule,source:pointRule,
  points:{type:'array',description:'Brush/repair stroke in original coordinates; at least one point',items:pointRule,minItems:1},
  radius:number('Brush radius as a fraction of the original short edge',0.00001,1),
  rx:number('Ellipse x radius as original width fraction',0.00001,1),ry:number('Ellipse y radius as original height fraction',0.00001,1),
  opacity:number('Local effect strength',0,1),feather:number('Soft edge fraction; zero is hard',0,1),
  invert:{type:'boolean',description:'Invert mask coverage'},enabled:{type:'boolean',description:'Enable this local edit'},
  raster:{type:'object',description:'Normalized full-original soft mask, bilinearly sampled',properties:{width:{type:'integer',minimum:1},height:{type:'integer',minimum:1},encoding:{type:'string',enum:['base64-u8']},data:{type:'string',description:'Base64 grayscale samples in 0..255'}},required:['width','height','encoding','data'],additionalProperties:false},
  provenance:{type:'object',description:'Model/source metadata for an external semantic raster'},
  adjustments:{type:'object',properties:Object.fromEntries(Object.entries(LOCAL_CONTROLS).map(([key,[min,max]])=>[key,number('Local '+key,min,max)])),additionalProperties:false}
}
const localDefinitions={}
for(const kind of ['mask','repair']){
  const properties=Object.fromEntries(Object.entries(localProperties).filter(([key])=>kind==='mask'?key!=='source':!['start','end','center','rx','ry','invert','adjustments','raster','provenance'].includes(key)))
  properties.type={...properties.type,enum:kind==='mask'?['linear','radial','brush','semantic']:['clone','heal']}
  localDefinitions[kind+'.add']=entry('Add a non-destructive '+(kind==='mask'?'linear/radial/brush adjustment mask':'clone or mean-color matched texture repair'),{[kind]:{type:'object',properties,required:['type'],additionalProperties:false}},[kind])
  localDefinitions[kind+'.update']=entry('Update local '+kind+' geometry, strength or adjustments',{id:string('Local tool ID from state'),changes:{type:'object',properties:Object.fromEntries(Object.entries(properties).filter(([key])=>key!=='type')),additionalProperties:false}},['id','changes'])
  localDefinitions[kind+'.remove']=entry('Remove a local '+kind,{id:string('Local tool ID from state')},['id'])
  for(const action of ['add','update','remove'])localDefinitions[kind+'.'+action].parameters.properties.photoId=string('Optional selected-photo guard; rejects if selection has changed')
}

// This command catalog is shared by offline CLI discovery and the live GUI agent.
export const definitions={
  ...localDefinitions,
  'grid-layout':entry('Set the library grid layout',{layout:string('Layout',{enum:['square','mosaic']})},['layout']),
  'select-inverse':entry('Invert selection in the current view'),
  'virtual-copy':entry('Create a separate edit recipe sharing the original library file'),
  'save-frame':entry('Save the current edited video frame as a library photo'),
  stack:entry('Group selected library photos into a stack'),
  'stack-cover':entry('Use the selected photo as the stack cover'),
  'stack-toggle':entry('Expand or collapse the active stack'),
  unstack:entry('Ungroup the current stack'),
  'auto-stack':entry('Group library images by capture interval or visual similarity',{by:string('Grouping method',{enum:['time','similarity']}),threshold:{type:'number',minimum:0,description:'Seconds, or normalized RGB difference for similarity'}}),
  slideshow:entry('Start or stop a slideshow through the current view',{seconds:number('Seconds per photo',.2,3600),stop:{type:'boolean'}}),
  'video-play':entry('Play the selected clip in detail view'),
  'video-pause':entry('Pause video playback'),
  'video-seek':entry('Seek to a frame in seconds',{time:{type:'number',minimum:0}},['time']),
  'video-trim':entry('Set nondestructive in and out points in seconds',{start:{type:'number',minimum:0},end:{type:'number',minimum:0}},['start','end']),
  'ai-mask':entry('Run real local semantic segmentation and add a soft adjustment mask; sky downloads a fixed 172 MB model once',{
    target:string('Semantic selection',{enum:AI_TARGETS}),photoId:string('Optional selected-photo guard'),adjustments:localProperties.adjustments
  },['target']),
  'apply-xmp':entry('Apply an XMP sidecar to the active photo',{xml:string('XMP RDF/XML document')},['xml']),
  sync:entry('Synchronize the imported library with an explicitly selected WebDAV folder',{
    endpoint:string('HTTPS WebDAV folder URL'),username:string('Optional username'),password:string('Optional password'),
    prefer:string('Resolve conflicting records in favor of one side',{enum:['','local','remote']})
  },['endpoint']),
  state:entry('Read the current GUI selection, visible photos, edit recipes and albums',{summary:{type:'boolean',description:'Return selection, count and current photo metadata only'}}),
  photos:entry('Page through compact visible photo metadata',{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1}}),
  import:entry('Import image files into the live catalog', {files:{type:'array',description:'CLI paths become File objects in the GUI',items:{type:'string'}}}, ['files']),
  'local-folders':entry('List previously authorized photo folders without importing originals'),
  'local-open':entry('Choose a folder in the desktop dialog or reopen an authorized folder ID',{
    root:string('Authorized folder ID from local-folders; omit to choose with the system dialog'),
    relative:string('Relative subfolder inside the authorized root')
  }),
  'local-browse':entry('Browse a subfolder of the current authorized local root',{relative:string('Relative subfolder, or . for the root')},['relative']),
  library:entry('Return to the imported photo library'),
  'external-editor':entry('Choose an installed image editor, or use detected Photoshop',{photoshop:{type:'boolean',description:'Detect Photoshop instead of opening the editor picker'}}),
  'external-edit':entry('Send an edited TIFF copy to the configured external editor; originals stay unchanged'),
  'external-check':entry('Import stable saved external copies as new derived library photos'),
  tether:entry('Open the tethered capture panel and discover connected still cameras'),
  'camera-list':entry('Discover actual WIA or gphoto2 still cameras and report backend availability'),
  'camera-capture':entry('Trigger the selected supported camera, keep camera originals, and import downloaded photos',{id:string('Camera ID from camera-list')},['id']),
  select:entry('Select a photo in the current view',{id:string('Photo ID from state'),toggle:{type:'boolean',description:'Toggle membership in the selection'},range:{type:'boolean',description:'Select the visible range from the selection anchor'}},['id']),
  'select-many':entry('Select an explicit list of visible photo IDs; an empty array clears selection',{ids:{type:'array',items:{type:'string'},description:'Visible photo IDs'}},['ids']),
  'select-all':entry('Select every photo in the current filtered view'),
  'merge-hdr':entry('Align selected original exposure brackets, recover calibrated linear radiance, and create a tone-mapped library photo',{
    ids:{type:'array',items:{type:'string'},description:'Optional ordered source IDs; defaults to the current selection'},
    evs:{type:'array',items:{type:'number'},description:'Brightness offsets in stops, one per source; defaults to exposure time/aperture/ISO EXIF'},
    align:{type:'boolean',description:'Auto align; set false only for fixed, identically framed tripod images'}
  }),
  'merge-panorama':entry('Register overlapping originals with ORB/RANSAC and create a projective feather-blended library panorama',{
    ids:{type:'array',items:{type:'string'},description:'Optional ordered source IDs; defaults to the current selection'}
  }),
  'export-hdr':entry('Export selected HDR merge as scene-linear Radiance RGBE, before subsequent display edits',{},[],{returns:'image/vnd.radiance'}),
  view:entry('Switch between grid and detail editing',{inspector:{type:'boolean',description:'Show editing controls in detail'},mode:string('Workspace view',{enum:['grid','detail']})},['mode']),
  scope:entry('Show all, flagged, deleted, or an album',{id:string('all, picked, trash, or an album ID')},['id']),
  search:entry('Filter photos by filename and keywords',{text:string('Search text; empty clears the filter')},['text']),
  sort:entry('Sort the visible photographs',{order:string('Sort order',{enum:['recent','name','rating','capture']}),direction:string('Sort direction; default name ascending, other orders descending',{enum:['asc','desc']})},['order']),
  filter:entry('Filter the current scope by minimum rating, flag, and edit status',{
    rating:number('Minimum star rating',0,5,{type:'integer'}),flag:string('Flag filter',{enum:['any','pick','reject','unflagged']}),edited:string('Edit status filter',{enum:['any','yes','no']})
  }),
  album:entry('Create an album',{name:string('Nonempty album name'),smart:{type:'boolean',description:'Use current search and filters as a live album rule'}},['name']),
  'album-rename':entry('Rename an album',{id:string('Album ID'),name:string('New nonempty name')},['id','name']),
  'album-delete':entry('Delete an album while retaining its photos and other memberships',{id:string('Album ID')},['id']),
  membership:entry('Toggle selected photo membership in an album',{album:string('Album ID from state')},['album']),
  rate:entry('Set the selected photo star rating',{value:number('Star rating',0,5,{type:'integer'})},['value']),
  flag:entry('Set picked, rejected, or unflagged',{value:string('Empty string clears the flag',{enum:['pick','reject','']})},['value']),
  keywords:entry('Set keywords on the selected photo',{value:string('Keywords text')},['value']),
  delete:entry('Move the selected photo to Deleted without removing its original'),
  restore:entry('Restore the selected photo from Deleted'),
  'copy-edits':entry('Copy active-photo edits for pasting to the selected group',{keys:{type:'array',items:{type:'string'},description:'Optional edit keys to copy; omit for the entire recipe'}}),
  'paste-edits':entry('Paste copied edits to every selected photo, with per-photo undo'),
  'version-save':entry('Save a named immutable edit snapshot on the active photo',{name:string('Version name')},['name']),
  'version-restore':entry('Restore a saved version on the active photo',{id:string('Version ID from state')},['id']),
  'version-rename':entry('Rename a saved version on the active photo',{id:string('Version ID'),name:string('New name')},['id','name']),
  'version-delete':entry('Delete a saved version without changing current edits',{id:string('Version ID')},['id']),
  edit:entry('Change one non-destructive adjustment, crop, rotation or flip',{
    key:string('Case-sensitive adjustment key',{enum:[...Object.keys(edits),'turn','flip','aspect','crop']}),
    value:{description:'Adjustment number, turn 0..3, flip boolean, aspect string, or normalized crop {x,y,w,h} (null clears)',oneOf:[{type:'number'},{type:'boolean'},{type:'string'},{type:'object'},{type:'null'}]}
  },['key','value'],{editControls:edits, specialControls:{turn:[0,1,2,3],flip:[true,false],aspect:['','1','1.5','1.7777777778','0.8']}}),
  'compare-pair':entry('Show original and edited images side by side'),
  'sample-tool':entry('Toggle white balance sampler'),
  'white-balance':entry('Neutralize a patch at normalized original-image coordinates',{x:number('Horizontal position',0,1),y:number('Vertical position',0,1)},['x','y']),
  fullscreen:entry('Toggle the desktop window fullscreen state'),
  panel:entry('Open or close a workspace panel',{name:string('Panel title or photos for navigation'),open:{type:'boolean',description:'Requested open state for editing panels'}},['name']),
  'local-tool':entry('Activate a local editing tool',{tool:string('Tool',{enum:['off','brush','linear','radial','clone','heal']})},['tool']),
  screenshot:entry('Capture the visible desktop workspace as a PNG',{},[],{returns:'image/png'}),
  presets:entry('List built-in and saved adjustment presets'),
  'preset-save':entry('Save global adjustments as a reusable preset',{name:string('Preset name')},['name']),
  'preset-apply':entry('Apply a preset to the selected photo',{id:string('Preset ID')},['id']),
  'preset-delete':entry('Delete a saved preset',{id:string('Preset ID')},['id']),
  histogram:entry('Return RGB and luminance bin counts sampled from the current edited image'),
  'auto-tone':entry('Set exposure using the median luminance of the original'),
  'crop-tool':entry('Open or close the crop rectangle tool'),
  reset:entry('Reset all selected-photo edits'),
  undo:entry('Undo an edit on the selected photo in the current GUI session'),
  redo:entry('Redo an edit on the selected photo in the current GUI session'),
  compare:entry('Toggle the original image comparison in detail view'),
  film:entry('Toggle the detail-view filmstrip'),
  zoom:entry('Toggle fit versus full-resolution detail view'),
  preview:entry('Read the current edited or comparison image as PNG',{maxSize:{type:'integer',minimum:1,description:'Maximum image edge in pixels'}},[],{returns:'image/png'}),
  export:entry('Export selected photo bytes without opening a native save dialog',{
    format:string('Image format',{enum:EXPORT_TYPES}),
    maxSize:{type:'integer',minimum:1,description:'Longest edge in pixels. Defaults to original size.'},
    watermark:string('Optional text at lower right'),
    quality:number('JPEG/AVIF/JPEG XL quality; 1 selects lossless AVIF/JXL',0,1)
  },[],{returns:'image'})
}

export const commands=Object.fromEntries(Object.entries(definitions).map(([name,definition])=>[
  name,Object.entries(definition.parameters.properties).map(([key,p])=>key+(definition.parameters.required.includes(key)?'':'?')+': '+(p.enum?.join('|')??p.type??'value')).join(', ')
]))

export function schema(command){
  if(!Object.hasOwn(definitions,command))throw new Error('Unknown command: '+command)
  return {command,...definitions[command]}
}

export function searchCommands(query){
  const words=String(query).toLowerCase().split(/\s+/).filter(Boolean)
  return Object.entries(definitions).map(([command,definition])=>({command,summary:definition.summary,score:words.reduce((score,word)=>score+(command===word?5:command.includes(word)?3:JSON.stringify(definition).toLowerCase().includes(word)?1:0),0)}))
    .filter(item=>item.score||words.length===0).sort((a,b)=>b.score-a.score||a.command.localeCompare(b.command)).slice(0,5).map(({score,...item})=>item)
}

export function validateArgs(command,args){
  const {parameters}=schema(command)
  if(!args||Array.isArray(args)||typeof args!=='object')throw new Error('Arguments must be a JSON object')
  for(const required of parameters.required)if(!Object.hasOwn(args,required))throw new Error('Missing argument: '+required)
  for(const [key,value]of Object.entries(args)){
    const rule=parameters.properties[key]
    if(!rule)throw new Error('Unknown argument: '+key)
    if(rule.type==='array'&&!Array.isArray(value))throw new Error(key+' must be an array')
    if(rule.type&&rule.type!=='array'&&(rule.type==='integer'?!Number.isInteger(value):typeof value!==rule.type))throw new Error(key+' must be '+rule.type)
    if(rule.enum&&!rule.enum.includes(value))throw new Error(key+' must be one of '+JSON.stringify(rule.enum))
    if(typeof value==='number'&&(!Number.isFinite(value)||value<rule.minimum||value>rule.maximum))throw new Error(key+' is outside its valid range')
    if(rule.oneOf&&!rule.oneOf.some(choice=>typeof value===choice.type))throw new Error('Invalid value for '+key)
  }
  if(command==='edit'){
    const {key,value}=args
    if(Object.hasOwn(edits,key)){
      const [minimum,maximum]=edits[key]
      if(typeof value!=='number'||!Number.isFinite(value)||value<minimum||value>maximum)throw new Error(key+' must be between '+minimum+' and '+maximum)
    }else if(key==='crop'){if(value!==null&&!validCrop(value))throw Error('Invalid crop rectangle')}
    else if(!definitions.edit.specialControls[key]?.includes(value))throw new Error('Invalid value for '+key)
  }
  if(command==='mask.add'||command==='repair.add')validateLocalTool(command.split('.')[0],args[command.split('.')[0]])
  if(command==='mask.update'||command==='repair.update')validateLocalChanges(command.split('.')[0],args.changes)
  if(command==='ai-mask'&&args.adjustments!==undefined)validateLocalChanges('mask',{adjustments:args.adjustments})
  return args
}
