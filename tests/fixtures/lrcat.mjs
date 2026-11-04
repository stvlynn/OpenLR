// Explicit synthetic relationship fixture. Never exported from a user's or
// Adobe's real catalog. Schema capabilities are documented in its README.
import initSqlJs from 'sql.js'
import { deflateSync } from 'node:zlib'
export async function makeLrcat({ broken = false, version = '1500000', xmp = true } = {}) {
  const SQL = await initSqlJs(),
    db = new SQL.Database()
  db.run(`CREATE TABLE Adobe_variablesTable(name,value);
 CREATE TABLE Adobe_images(id_local INTEGER PRIMARY KEY,id_global,rootFile,rating,pick,colorLabels,fileWidth,fileHeight,masterImage,copyName,orientation,captureTime);
 CREATE TABLE AgLibraryRootFolder(id_local INTEGER PRIMARY KEY,absolutePath,name);
 CREATE TABLE AgLibraryFolder(id_local INTEGER PRIMARY KEY,rootFolder,pathFromRoot);
 CREATE TABLE AgLibraryFile(id_local INTEGER PRIMARY KEY,folder,baseName,extension,idx_filename);
 CREATE TABLE AgLibraryCollection(id_local INTEGER PRIMARY KEY,name,parent,creationId,systemOnly);
 CREATE TABLE AgLibraryCollectionImage(collection,image);
 CREATE TABLE AgLibraryKeyword(id_local INTEGER PRIMARY KEY,name,parent);
 CREATE TABLE AgLibraryKeywordImage(image,tag);
 CREATE TABLE Adobe_imageDevelopSettings(image,text,hasMasks,hasBigData);
 CREATE TABLE Adobe_AdditionalMetadata(image,xmp);`)
  db.run('INSERT INTO Adobe_variablesTable VALUES (?,?)', ['Adobe_DBVersion', version])
  db.run("INSERT INTO AgLibraryRootFolder VALUES (1,'Z:/synthetic-originals/','Synthetic old drive')")
  db.run("INSERT INTO AgLibraryFolder VALUES (10,1,'Album/')")
  db.run(
    "INSERT INTO AgLibraryFile VALUES (101,10,'first','png','first.png'),(102,10,'missing','png','missing.png'),(103,10,'second','png','second.png')"
  )
  db.run(
    "INSERT INTO Adobe_images VALUES (201,'synthetic-first',101,4,1,'red',80,60,NULL,NULL,'AB','2026-01-01T12:00:00'),(202,'synthetic-missing',102,2,-1,'',80,60,NULL,NULL,'AB',NULL),(203,'synthetic-copy',101,3,0,'',80,60,201,'Virtual crop','AB',NULL),(204,'synthetic-broken',999,0,0,'',0,0,NULL,NULL,'AB',NULL),(205,'synthetic-second',103,1,0,'blue',80,60,NULL,NULL,'AB',NULL)"
  )
  db.run(
    "INSERT INTO AgLibraryCollection VALUES (1,'Trips',NULL,'com.adobe.ag.library.group',''),(2,'Test album',1,'com.adobe.ag.library.collection',''),(3,'Smart rating',NULL,'com.adobe.ag.library.smart_collection',''),(4,'System',NULL,'com.adobe.ag.library.collection','1')"
  )
  db.run('INSERT INTO AgLibraryCollectionImage VALUES (2,201),(2,202),(2,203),(2,205)')
  db.run(
    "INSERT INTO AgLibraryKeyword VALUES (1,'Places',NULL),(2,'Synthetic',1);INSERT INTO AgLibraryKeywordImage VALUES (201,2),(202,1)"
  )
  db.run('INSERT INTO Adobe_imageDevelopSettings VALUES (?,?,0,0)', [
    201,
    's = { Exposure2012 = 0.75, Contrast2012 = 10, Temperature = 5500, Nested = { Exposure2012 = -4 } }'
  ])
  db.run('INSERT INTO Adobe_imageDevelopSettings VALUES (?,?,0,0)', [203, 's = { Exposure2012 = -0.5 }'])
  if (xmp) {
    const xml = Buffer.from(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.25" crs:Vibrance="20"/></rdf:RDF></x:xmpmeta>'
      ),
      size = Buffer.alloc(4)
    size.writeUInt32BE(xml.length)
    db.run('INSERT INTO Adobe_AdditionalMetadata VALUES (?,?)', [
      201,
      Buffer.concat([size, deflateSync(xml)])
    ])
  }
  if (broken) db.run('DROP TABLE AgLibraryFolder')
  const bytes = db.export()
  db.close()
  return bytes
}
