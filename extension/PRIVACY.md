# Blog Bunker extension — privacy

- The extension only reads a page when you click its icon and press "Summarize this page" (it uses Chrome's `activeTab` permission, which applies to that one tab for that one click).
- The text of that page (or your selection) is sent to your Blog Bunker account to be summarized by AI. It is not sent anywhere else and is not stored beyond the summary you choose to save.
- The extension stores a pairing code and your workspace names in Chrome's local extension storage. "Disconnect" removes them; "Disconnect all browsers" in Blog Bunker settings revokes the code on the server.
