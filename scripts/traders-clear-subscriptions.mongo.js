/**
 * IMMEDIATE ROLLBACK of the traders app's feed load — the operator runs it, by
 * hand, AFTER `npx pm2 stop dx-traders` (docs/runbooks/traders.md, section 5):
 *
 *   mongosh --file scripts/traders-clear-subscriptions.mongo.js
 *
 * It empties the one `desk-subscriptions` document desk-traders declares
 * ({source:'traders'}), so desk-marketdata drops those tokens at its next
 * union instead of honouring the stopped app's last declaration for 10 minutes.
 * It touches no other document and no other collection. Started again,
 * desk-traders rewrites the document within 15 s.
 */
db.getSiblingDB('algomaker_dx')['desk-subscriptions'].updateOne({source:'traders'},{$set:{tokens:[],updatedAt:Date.now()}})
