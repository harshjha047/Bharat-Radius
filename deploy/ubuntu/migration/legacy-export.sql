-- Snapshot of the old Bharat Radius database (RadiusSoftwareDb, restored as bharatradius_legacy) as one JSON
-- document for `cli.js import-legacy`. Pipe it straight into the importer; never save it (it holds PPPoE passwords).
-- Router secrets, gateway keys, staff password hashes and logs are not exported.
--   sudo -u postgres psql -d bharatradius_legacy -XAtq -f legacy-export.sql | docker compose ... exec -T api node dist/cli.js import-legacy --tenant <slug>
select json_build_object(
  'exportedAt', now(),
  'sites', (
    select coalesce(json_agg(json_build_object(
      'id', s."Id", 'parentId', s."ParentSiteId", 'msr', s."SiteMsrNumber", 'parentMsr', s."ParentSiteMsrNumber",
      'level', s."SiteLevel", 'name', s."SiteName", 'company', s."CompanyName", 'email', s."SiteEmail",
      'mobile', s."SiteMobileNo", 'address', s."SiteAddress", 'city', s."City", 'state', s."State", 'zip', s."Zip",
      'active', s."IsActive", 'deleted', s."IsDeleted",
      'balance', (select w."Balance"::text from "SiteWallets" w where w."SiteId" = s."Id")
    ) order by s."SiteLevel", s."SiteMsrNumber"), '[]'::json)
    from "Sites" s
  ),
  'plans', (
    select coalesce(json_agg(json_build_object(
      'id', p."Id", 'siteId', p."SiteId", 'name', p."PackageName",
      'download', p."DownloadMbps"::text, 'downloadUnit', p."DownloadUnit",
      'upload', p."UploadMbps"::text, 'uploadUnit', p."UploadUnit",
      'price', p."Price"::text, 'validity', p."ExpiryDays", 'validityType', p."ValidityType",
      'active', p."IsActive"
    ) order by p."PackageName"), '[]'::json)
    from "PackageProfiles" p
  ),
  'nas', (
    select coalesce(json_agg(json_build_object(
      'id', n."Id", 'siteId', n."SiteId", 'name', n."NasName", 'ip', n."NasIpAddress",
      'coaPort', n."CoaPort", 'enabled', n."IsEnabled"
    ) order by n."NasName"), '[]'::json)
    from "NasDevices" n
  ),
  'subscribers', (
    select coalesce(json_agg(json_build_object(
      'id', x."Id", 'siteId', x."SiteId", 'nasId', x."NasId", 'planId', x."PackageId",
      'name', x."FullName", 'company', x."CompanyName", 'mobile', x."Mobile", 'email', x."Email",
      'address', x."Address", 'city', x."City", 'state', x."State", 'zip', x."Zip", 'gstin', x."GstNo",
      'comment', x."Comment", 'username', x."PPPoEUsername", 'password', x."PPPoEPassword",
      'mac', x."MacAddress", 'staticIp', x."StaticIp", 'connectionEnabled', x."ConnectionEnabled",
      'expireDate', x."ExpireDate", 'createdAt', x."CreatedAt"
    ) order by x."CreatedAt"), '[]'::json)
    from "Subscribers" x
  )
);
