// Node 22+. Explicitly run with your hub and a read-only integration token.
// Environment values are never printed or included in task text.
import {createPlexiformClient} from './remote-client.mjs';
const client=createPlexiformClient({origin:process.env.PLEXIFORM_HUB,token:process.env.PLEXIFORM_INTEGRATION_TOKEN});
const page=await client.getWorkContext({board_id:process.env.PLEXIFORM_BOARD,limit:5});
console.log(JSON.stringify(page,null,2));
