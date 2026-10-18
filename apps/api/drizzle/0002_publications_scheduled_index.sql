CREATE UNIQUE INDEX "publications_active_unique" ON "publications" USING btree ("story_id","story_version_no","provider") WHERE status in ('scheduled','publishing','submitted');
