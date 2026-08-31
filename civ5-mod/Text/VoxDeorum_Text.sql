INSERT OR REPLACE INTO Language_en_US (Tag, Text)
VALUES ('TXT_KEY_SPECIFIC_DIPLO_STRING_1', 'Their leader has expressed a public opinion of you (%d).');

INSERT OR REPLACE INTO Language_en_US (Tag, Text)
VALUES ('TXT_KEY_SPECIFIC_DIPLO_STRING_1_SELF', 'Our leader has expressed a public opinion of you (%d).');

INSERT OR REPLACE INTO Language_en_US (Tag, Text)
VALUES ('TXT_KEY_SPECIFIC_DIPLO_STRING_2', 'Their leader has formed a private opinion of you (%d).');

INSERT OR REPLACE INTO Language_en_US (Tag, Text)
VALUES ('TXT_KEY_SPECIFIC_DIPLO_STRING_2_SELF', 'Our leader has formed a private opinion of you (%d).');

-- Vox Deorum: relocated from SQL/VoxDeorum_Options.sql. That file's statements were
-- confirmed to execute cleanly when run directly against a copy of the merged database
-- (proving the SQL itself is correct), yet consistently applied zero rows in-game --
-- verified both before and after reordering it within OnModActivated, ruling out simple
-- activation-order or one-time-cache explanations. The actual mechanism is unresolved;
-- see docs/plans/windows-onboarding-learnings.md. This file (VoxDeorum_Text.sql) merges
-- reliably every launch, so its statements were moved here as a working workaround.
UPDATE CustomModOptions	SET Value = 1 WHERE Name = 'IPC_CHANNEL';
UPDATE CustomModOptions	SET Value = 1 WHERE Name like 'EVENTS_%';

INSERT INTO Flavors
	(Type)
VALUES
	('FLAVOR_MOBILIZATION');
