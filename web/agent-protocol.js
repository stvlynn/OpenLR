import {controls} from './render.js'
import {validCrop} from './geometry.js'
import {LOCAL_CONTROLS,validateLocalTool,validateLocalChanges} from './local-tools.js'

const string = (description, extra={}) => ({type:'string', description, ...extra})
const number = (description, minimum, maximum, extra={}) => ({type:'number', description, minimum, maximum, ...extra})
const entry = (summary, properties={}, required=[], extra={}) => ({summary, parameters:{type:'object', properties, required, additionalProperties:false}, ...extra})
const edits=Object.assign({},...Object.values(controls))
const pointRule={type:'object',description:'Normalized original-image point, before crop/rotate/flip',properties:{x:number('Original x fraction',0,1),y:number('Original y fraction',0,1)},required:['x','y'],additionalProperties:false}
const localProperties={
  type:string('Tool shape',{enum:['linear','radial','brush','clone','heal']}),
  start:pointRule,end:pointRule,center:pointRule,source:pointRule,
  points:{type:'array',description:'Brush/repair stroke in original coordinates; at least one point',items:pointRule,minItems:1},
  radius:number('Brush radius as a fraction of the original short edge',0.00001,1),
  rx:number('Ellipse x radius as original width fraction',0.00001,1),ry:number('Ellipse y radius as original height fraction',0.00001,1),
  opacity:number('Local effect strength',0,1),feather:number('Soft edge fraction; zero is hard',0,1),
  invert:{type:'boolean',description:'Invert mask coverage'},enabled:{type:'boolean',description:'Enable this local edit'},
  adjustments:{type:'object',properties:Object.fromEntries(Object.entries(LOCAL_CONTROLS).map(([key,[min,max]])=>[key,number('Local '+key,min,max)])),additionalProperties:false}
}
const localDefinitions={}
for(const kind of ['mask','repair']){
  const properties=Object.fromEntries(Object.entries(localProperties).filter(([key])=>kind==='mask'?key!=='source':!['start','end','center','rx','ry','invert','adjustments'].includes(key)))
  properties.type={...properties.type,enum:kind==='mask'?['linear','radial','brush']:['clone','heal']}
  localDefinitions[kind+'.add']=entry('Add a non-destructive '+(kind==='mask'?'linear/radial/brush adjustment mask':'clone or mean-color matched texture repair'),{[kind]:{type:'object',properties,required:['type'],additionalProperties:false}},[kind])
  localDefinitions[kind+'.update']=entry('Update local '+kind+' geometry, strength or adjustments',{id:string('Local tool ID from state'),changes:{type:'object',properties:Object.fromEntries(Object.entries(properties).filter(([key])=>key!=='type')),additionalProperties:false}},['id','changes'])
  localDefinitions[kind+'.remove']=entry('Remove a local '+kind,{id:string('Local tool ID from state')},['id'])
}

// This command catalog is shared by offline CLI discovery and the live GUI agent.
export const definitions={
  ...localDefinitions,
  state:entry('Read the current GUI selection, visible photos, edit recipes and albums'),
  import:entry('Import image files into the live catalog', {files:{type:'array',description:'CLI paths become File objects in the GUI',items:{type:'string'}}}, ['files']),
  'local-folders':entry('List previously authorized photo folders without importing originals'),
  'local-open':entry('Choose a folder in the desktop dialog or reopen an authorized folder ID',{
    root:string('Authorized folder ID from local-folders; omit to choose with the system dialog'),
    relative:string('Relative subfolder inside the authorized root')
  }),
  'local-browse':entry('Browse a subfolder of the current authorized local root',{relative:string('Relative subfolder, or . for the root')},['relative']),
  library:entry('Return to the imported photo library'),
  select:entry('Select a photo in the current view',{id:string('Photo ID from state')},['id']),
  view:entry('Switch between grid and detail editing',{mode:string('Workspace view',{enum:['grid','detail']})},['mode']),
  scope:entry('Show all, flagged, deleted, or an album',{id:string('all, picked, trash, or an album ID')},['id']),
  search:entry('Filter photos by filename and keywords',{text:string('Search text; empty clears the filter')},['text']),
  sort:entry('Sort the visible photographs',{order:string('Sort order',{enum:['recent','name','rating']})},['order']),
  album:entry('Create an album',{name:string('Nonempty album name')},['name']),
  membership:entry('Toggle selected photo membership in an album',{album:string('Album ID from state')},['album']),
  rate:entry('Set the selected photo star rating',{value:number('Star rating',0,5,{type:'integer'})},['value']),
  flag:entry('Set picked, rejected, or unflagged',{value:string('Empty string clears the flag',{enum:['pick','reject','']})},['value']),
  keywords:entry('Set keywords on the selected photo',{value:string('Keywords text')},['value']),
  delete:entry('Move the selected photo to Deleted without removing its original'),
  restore:entry('Restore the selected photo from Deleted'),
  edit:entry('Change one non-destructive adjustment, crop, rotation or flip',{
    key:string('Case-sensitive adjustment key',{enum:[...Object.keys(edits),'turn','flip','aspect','crop']}),
    value:{description:'Adjustment number, turn 0..3, flip boolean, aspect string, or normalized crop {x,y,w,h} (null clears)',oneOf:[{type:'number'},{type:'boolean'},{type:'string'},{type:'object'},{type:'null'}]}
  },['key','value'],{editControls:edits, specialControls:{turn:[0,1,2,3],flip:[true,false],aspect:['','1','1.5','1.7777777778','0.8']}}),
  histogram:entry('Return RGB and luminance bin counts sampled from the current edited image'),
  'auto-tone':entry('Set exposure using the median luminance of the original'),
  'crop-tool':entry('Open or close the crop rectangle tool'),
  reset:entry('Reset all selected-photo edits'),
  undo:entry('Undo an edit on the selected photo in the current GUI session'),
  redo:entry('Redo an edit on the selected photo in the current GUI session'),
  compare:entry('Toggle the original image comparison in detail view'),
  film:entry('Toggle the detail-view filmstrip'),
  zoom:entry('Toggle fit versus full-resolution detail view'),
  preview:entry('Read the current edited or comparison image as PNG',{maxSize:number('Maximum image edge in pixels',1,8192)},[],{returns:'image/png'}),
  export:entry('Export selected photo bytes without opening a native save dialog',{
    format:string('Image format',{enum:['image/jpeg','image/png','original']}),
    quality:number('JPEG quality',0,1)
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
  return args
}
