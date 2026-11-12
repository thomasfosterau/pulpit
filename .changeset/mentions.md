---
"@thomasfosterau/pulpit": minor
---

`./notifications` mentions (pulpit#198): `mentionCreatedHook({ outbox, fields, documents, extract })` is a before hook that emits `mention.created` for the accounts a write's documents newly mention. It extracts the mentions from every document the write sets in a declared field (every locale's too), subtracts those the head's documents already mention, and writes one draft per account left to the outbox in the write's transaction, so an edit that keeps or moves a mention notifies nobody again. The recipient is gated at fan-out like every node subject: a mention of an account that can't read the node, or that blocks or is blocked by the author, is dropped. The extraction is a new seam, `MentionExtractor<Document>` (`(document) => accountIds`), which the application fills with its document grammar's extractor; `./testing` adds its reference fake, `jsonMentionExtractor`.
