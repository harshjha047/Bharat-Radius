# Notes for working in this repo

## DIV credit ("Powered by <Div/>")

Bharat Radius is built and run by DIV (Development Innovation Vector Pvt. Ltd., https://thediv.in).
The credit is deliberate: it is how DIV gets mentioned and earns backlinks from every ISP install.
Keep it on every surface and keep it a link.

- `PoweredBy` (`apps/web/src/components/brand.tsx`) links to `DIV_PRODUCT_URL`, the Bharat Radius
  page on thediv.in, with UTM tags (`utm_source=bharat-radius`, `utm_medium=panel|portal|login`) so
  DIV can count leads from ISP staff, resellers and customers.
- The landing page (`/`, indexable) carries a clean, followed "Bharat Radius by DIV" link. Use the
  brand as anchor text, never keyword-stuffed text (footer links repeated across many client sites
  with keyword anchors read as a link scheme).
- Public login pages are `noindex, follow`: out of search results, but the credit still counts.
  The panel and portal stay `noindex` behind sign-in.
- Each ISP runs on its own domain, so each install's landing page is one more referring domain.
