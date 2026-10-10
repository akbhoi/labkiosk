-- What a conversation is about, and with it the prefix of its tracking id.
--
-- Every conversation used to carry an `LK-` reference whatever it was. New
-- ones are filed by purpose (registration, Remote Control, support, sales,
-- billing, legal, general, a letter the platform wrote) and their tracking id
-- starts with that purpose's prefix (REG-, RMT-, SUP-, SAL-, BIL-, LGL-, GEN-,
-- LTR-). Existing conversations keep their `LK-` reference and are filed by
-- what they were: a task by its kind, mail by the address it was sent to.

ALTER TABLE conversations ADD COLUMN category TEXT NOT NULL DEFAULT 'general';

UPDATE conversations SET category = 'registration' WHERE kind = 'signup';
UPDATE conversations SET category = 'remote_control' WHERE kind = 'remote_control';
UPDATE conversations SET category = 'support'
  WHERE kind = 'support' AND mailbox IS NOT NULL
    AND substr(mailbox, 1, instr(mailbox, '@') - 1) IN ('support', 'help', 'helpdesk');
UPDATE conversations SET category = 'sales'
  WHERE kind = 'support' AND mailbox IS NOT NULL
    AND substr(mailbox, 1, instr(mailbox, '@') - 1) IN ('sales', 'quote', 'quotes', 'pricing', 'licensing');
UPDATE conversations SET category = 'billing'
  WHERE kind = 'support' AND mailbox IS NOT NULL
    AND substr(mailbox, 1, instr(mailbox, '@') - 1) IN ('billing', 'accounts', 'invoice', 'invoices', 'payments');
UPDATE conversations SET category = 'legal'
  WHERE kind = 'support' AND mailbox IS NOT NULL
    AND substr(mailbox, 1, instr(mailbox, '@') - 1) IN ('legal', 'privacy', 'abuse', 'security', 'compliance', 'dpo');

CREATE INDEX IF NOT EXISTS idx_conversations_category ON conversations(category, status);
