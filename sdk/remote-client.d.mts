export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export type Result = {[key:string]:Json};
export type Card = {id:string;board_id:string;key:string;title:string;version:number;fence:number;column:string} & Record<string,unknown>;
export type CardResult = {card:Card} & Record<string,unknown>;
export type Participant = {member_id:string;name:string;identity_source:'team_member'};
export type Packet = {schemaVersion:1;id:string;card_id:string;repo_id:string|null;fence:number;version:number;data:PacketData} & Record<string,unknown>;
export type Options = {signal?:AbortSignal};
export type CardInput = {board_id:string;request_id:string;title:string;body?:string;acceptance?:string};
export type PatchInput = {card_id:string;request_id:string;version:number;title?:string;body?:string;acceptance?:string};
export type PacketData = {brief:string;decisions:string[];progress:string;nextAction:string;reportedChecks:string[];artifacts:({kind:'path';path:string}|{kind:'evidence';id:string})[]};
export type PacketInput = {card_id:string;request_id:string;expected_version:number;expected_fence:number;data:PacketData};
export type MessageInput = {card_id:string;request_id:string;expected_fence:number;kind:'status'|'question'|'handoff'|'coordination';body:string;recipient_run_ids:string[];thread_id?:string;reply_to?:string};
export type WorkContextInput = {board_id:string;repo_id?:string;limit?:number;cursor?:string};
export type Ownership = {source:'runner_reported_declaration';run_id:string;state:'planned'|'editing'|'awaiting_review';reason:string|null;paths:string[];paths_truncated:boolean;expires_in_ms:number|null;advisory:true};
export type WorkTask = {
  card:{id:string;board_id:string;key:string;title:string;version:number;fence:number;column:string;run_state:string;blocked_kind:string|null;start_date:string|null;due_date:string|null;source:'hub_record'};
  repository:{id:string;name:string}|null;participants:Participant[];participants_truncated:boolean;
  run:{id:string;participant:Participant|null;provider:string;provider_label:string;identity_source:'hub_run';observation_source:'host_heartbeat'|'unavailable';last_seen_age_ms:number|null;fresh:boolean}|null;
  reported_activity:{source:'participant_local_observation';participant:Participant|null;provider:string;provider_label:string;status:string;reported_status:string;fresh:boolean;last_seen_age_ms:number|null;verified_run_identity:false}|null;
  ownership:Ownership|null;overlaps:{card_id:string;board_id:string;key:string;run_id:string;state:string;paths:string[];paths_truncated:boolean;advisory:true}[];overlaps_truncated:boolean;
  blockers:({kind:'dependency';card_id:string;board_id:string;key:string}|{kind:'permission'|'question';id:string;card_id:string})[];blockers_truncated:boolean;
  next_action:{source:'participant_reported';kind:'task_packet';card_id:string;packet_id:string;version:number;available:boolean}|null;
};
export type WorkContext = {schema:1;source:'current_hub_records';board:{id:string;name:string;key_prefix:string};repository_filter:string|null;tasks:WorkTask[];status:'complete'|'partial';next_cursor:string|null;advisory:true;grants_execution:false;limitations:string[]};
export declare const MAX_BYTES:number;
export declare class PlexiformError extends Error {constructor(code:string,status?:number,retryAfter?:number|null);code:string;status:number;retryAfter:number|null;}
export declare function requestId():string;
export interface PlexiformClient {
  catalog(options?:Options):Promise<Result>;
  listBoards(options?:Options):Promise<{boards:{id:string;name:string;key_prefix:string;archived:false}[]}>;
  listCards(args:{board_id:string;query?:string},options?:Options):Promise<{board:{id:string;name:string};cards:Card[]}>;
  getCard(args:{card_id:string},options?:Options):Promise<CardResult>;
  createCard(args:CardInput,options?:Options):Promise<CardResult>;
  updateCard(args:PatchInput,options?:Options):Promise<CardResult>;
  addComment(args:{card_id:string;request_id:string;body:string},options?:Options):Promise<{comment:{id:string;card_id:string;body:string;for_agent:false;application_verified:false;account_id:string|null} & Record<string,unknown>}>;
  readHandover(args:{card_id:string},options?:Options):Promise<Result>;
  readPacket(args:{card_id:string},options?:Options):Promise<{packet:Packet|null}>;
  writePacket(args:PacketInput,options?:Options):Promise<{packet:Packet}>;
  listMessages(args:{card_id:string},options?:Options):Promise<Result>;
  sendMessage(args:MessageInput,options?:Options):Promise<Result>;
  getWorkContext(args:WorkContextInput,options?:Options):Promise<WorkContext>;
}
export declare function createPlexiformClient(config:{origin:string;token:string;fetchImpl?:typeof fetch;timeoutMs?:number}):PlexiformClient;
