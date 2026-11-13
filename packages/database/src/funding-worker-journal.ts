import Database from 'better-sqlite3';
import { link, unlink, open as openFile } from 'node:fs/promises';
import { NativeFundingRepository, initializeNativeFundingRepository, type NativeFundingAuthority, type NativeFundingRecord } from './native-funding.js';
export interface FundingWorkerJournalMetadata { kind: 'funding-worker-private-v1'; journalId: string; initialProfileDigest: string; state: 'ready' | 'recovery-required'; }
export interface FundingWorkerJournal { repository: NativeFundingRepository; records(): NativeFundingRecord[]; metadata(): FundingWorkerJournalMetadata; close(): void; }
const fail = (): never => { throw new Error('NATIVE_FUNDING_WORKER_JOURNAL_INVALID'); };
const id = (value: string) => /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
function metadata(db: Database.Database, journalId: string): FundingWorkerJournalMetadata {
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
 if(tables.length!==4||tables.some(row=>!['funding_worker_journal_identity','native_funding','native_funding_clock','runtime_control'].includes(row.name)))fail();
 const row=db.prepare('SELECT kind,journal_id AS journalId,initial_profile_digest AS initialProfileDigest,state FROM funding_worker_journal_identity WHERE id=1').get() as FundingWorkerJournalMetadata|undefined;
 if(!row||row.kind!=='funding-worker-private-v1'||row.journalId!==journalId||!/^sha256:[a-f0-9]{64}$/.test(row.initialProfileDigest)||!['ready','recovery-required'].includes(row.state))fail();return row!;
}
/** Read-only snapshot verifier; understands this private schema, never canonical migrations. */
export function verifyFundingWorkerJournal(path:string,journalId:string):FundingWorkerJournalMetadata{
 if(!id(journalId))fail();const db=new Database(path,{readonly:true,fileMustExist:true});try{if(db.pragma('quick_check',{simple:true})!=='ok')fail();const result=metadata(db,journalId);const repo=new NativeFundingRepository(db,{assertCurrent(){fail();}});for(const row of db.prepare('SELECT id FROM native_funding').all() as {id:string}[])if(!repo.get(row.id))fail();return result;}finally{db.close();}
}
function connect(path:string,authority:NativeFundingAuthority,journalId:string):FundingWorkerJournal{
 const db=new Database(path,{fileMustExist:true});try{const info=metadata(db,journalId);if(info.state!=='ready')throw new Error('NATIVE_FUNDING_JOURNAL_RECOVERY_REQUIRED');db.pragma('busy_timeout = 5000');if(db.pragma('journal_mode = WAL',{simple:true})!=='wal')fail();db.pragma('synchronous = FULL');const repository=new NativeFundingRepository(db,authority);return{repository,records:()=> (db.prepare('SELECT id FROM native_funding ORDER BY created_at,id').all() as {id:string}[]).map(row=>repository.get(row.id)!),metadata:()=>metadata(db,journalId),close:()=>db.close()};}catch(error){db.close();throw error;}
}
/** Normal startup MUST find an existing matching initialized journal. Missing/empty/corrupt files never reset budgets. */
export function openFundingWorkerJournal(path:string,authority:NativeFundingAuthority,journalId:string):FundingWorkerJournal{const info=verifyFundingWorkerJournal(path,journalId);if(info.state!=='ready')throw new Error('NATIVE_FUNDING_JOURNAL_RECOVERY_REQUIRED');return connect(path,authority,journalId);}
/** Explicit first-install only. Caller exclusively creates the private empty file and confirms the exact public profile digest. */
export function initializeFundingWorkerJournal(path:string,authority:NativeFundingAuthority,journalId:string,profileDigest:string):FundingWorkerJournal{
 if(!id(journalId)||!/^sha256:[a-f0-9]{64}$/.test(profileDigest))fail();const db=new Database(path,{fileMustExist:true});try{if((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown[]).length)throw new Error('NATIVE_FUNDING_JOURNAL_ALREADY_INITIALIZED');db.exec("CREATE TABLE funding_worker_journal_identity(id INTEGER PRIMARY KEY CHECK(id=1),kind TEXT NOT NULL,journal_id TEXT NOT NULL,initial_profile_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','recovery-required'))); CREATE TABLE runtime_control(id TEXT PRIMARY KEY CHECK(id='global'),kill_switch_engaged INTEGER NOT NULL CHECK(kill_switch_engaged IN (0,1))); INSERT INTO runtime_control VALUES('global',0);");db.prepare("INSERT INTO funding_worker_journal_identity VALUES(1,'funding-worker-private-v1',?,?,'ready')").run(journalId,profileDigest);initializeNativeFundingRepository(db);}finally{db.close();}return connect(path,authority,journalId);
}
/** Consistent SQLite backup, not a raw live-file copy; caller encrypts and authenticates the result off host. */
export async function snapshotFundingWorkerJournal(source:string,destination:string,journalId:string):Promise<void>{verifyFundingWorkerJournal(source,journalId);const file=await openFile(destination,'wx',0o600);await file.close();const db=new Database(source,{readonly:true,fileMustExist:true});try{await db.backup(destination);verifyFundingWorkerJournal(destination,journalId);}catch(error){await unlink(destination).catch(()=>undefined);throw error;}finally{db.close();}}
/** Never activates old history. A restored snapshot remains blocked until explicit independently reviewed recovery. */
export async function restoreFundingWorkerJournal(snapshot:string,destination:string,journalId:string):Promise<void>{
 verifyFundingWorkerJournal(snapshot,journalId);const temporary=`${destination}.recovery`;const file=await openFile(temporary,'wx',0o600);await file.close();const source=new Database(snapshot,{readonly:true,fileMustExist:true});try{await source.backup(temporary);const restored=new Database(temporary,{fileMustExist:true});try{metadata(restored,journalId);restored.prepare("UPDATE funding_worker_journal_identity SET state='recovery-required' WHERE id=1").run();}finally{restored.close();}await link(temporary,destination);await unlink(temporary);}catch(error){await unlink(temporary).catch(()=>undefined);throw error;}finally{source.close();}
}
