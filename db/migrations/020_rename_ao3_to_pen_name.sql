ALTER TABLE story_writer CHANGE COLUMN AO3_name pen_name VARCHAR(255);

UPDATE config SET config_key = 'lblJoinPenName' WHERE config_key = 'lblJoinAO3Name';
UPDATE config SET config_key = 'txtJoinPenNameNotSet' WHERE config_key = 'txtJoinAO3NotSet';
UPDATE config SET config_key = 'btnJoinSetPenName' WHERE config_key = 'btnJoinSetAO3';
UPDATE config SET config_key = 'txtJoinPenNamePlaceholder' WHERE config_key = 'txtJoinAO3Placeholder';
UPDATE config SET config_key = 'btnSetPenName' WHERE config_key = 'btnSetAO3Name';
UPDATE config SET config_key = 'lblJoinSetPenNameModalTitle' WHERE config_key = 'lblJoinSetAO3ModalTitle';
UPDATE config SET config_key = 'lblYourPenName' WHERE config_key = 'lblYourAO3Name';
UPDATE config SET config_key = 'lblMyStoryManagePenName' WHERE config_key = 'lblMyStoryManageAO3';
UPDATE config SET config_key = 'txtPenNamePlaceholder' WHERE config_key = 'txtAO3NamePlaceholder';
UPDATE config SET config_key = 'txtAdminPenNameSuccess' WHERE config_key = 'txtAdminAO3NameSuccess';
UPDATE config SET config_key = 'lblManageUserPenName' WHERE config_key = 'lblManageUserAO3';
UPDATE config SET config_key = 'btnAdminMUPenName' WHERE config_key = 'btnAdminMUAO3Name';
UPDATE config SET config_key = 'txtAdminMUPenNamePlaceholder' WHERE config_key = 'txtAdminMUAO3Placeholder';
