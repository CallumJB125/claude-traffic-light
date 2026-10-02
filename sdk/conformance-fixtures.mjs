// Synthetic, caller-supplied current references. No authority or provider calls.
// Tests run each fixed SDK convenience against the actual shared server catalog.
export function collaborationFixtures({board_id,card_id,recipient_run_id,version,fence,requestId}){
  const item=(method,tool,args,key,write=false)=>({method,tool,args,key,write});
  return [
    item('listBoards','plexiform_list_boards',{},'boards'),
    item('listCards','plexiform_list_cards',{board_id},'cards'),
    item('getCard','plexiform_get_card',{card_id},'card'),
    item('readHandover','plexiform_read_handover',{card_id},'handover'),
    item('readPacket','plexiform_read_packet',{card_id},'packet'),
    item('listMessages','plexiform_list_messages',{card_id},'messages'),
    item('getWorkContext','plexiform_get_work_context',{board_id,limit:5},'tasks'),
    item('createCard','plexiform_create_card',{board_id,request_id:requestId(),title:'Conformance task'},'card',true),
    item('updateCard','plexiform_update_card',{card_id,request_id:requestId(),version,title:'Conformance current title'},'card',true),
    item('addComment','plexiform_add_comment',{card_id,request_id:requestId(),body:'Reported conformance review'},'comment',true),
    item('writePacket','plexiform_write_packet',{card_id,request_id:requestId(),expected_version:0,expected_fence:fence,data:{brief:'Conformance brief',decisions:[],progress:'Reported',nextAction:'Human review',artifacts:[],reportedChecks:[]}},'packet',true),
    item('sendMessage','plexiform_send_message',{card_id,request_id:requestId(),expected_fence:fence,kind:'coordination',body:'Reported conformance handoff',recipient_run_ids:[recipient_run_id]},'message',true),
  ];
}
