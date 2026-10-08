'use strict';

// Owning WebContents and its main frame are both required. A shared file URL
// does not grant another utility view (or a child frame) the same authority.
function fromPage(event, contents) {
  return !!contents && !contents.isDestroyed() && event?.sender === contents && event.senderFrame === contents.mainFrame;
}
module.exports = { fromPage };
