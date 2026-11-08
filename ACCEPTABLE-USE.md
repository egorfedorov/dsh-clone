# Acceptable use

`dsh-clone` rebuilds an interface from a picture. That is a normal design and engineering workflow, and it is also easy to misuse. This page is short on purpose.

## Fine

- Rebuilding **your own** designs, screenshots, mockups, or an interface you are migrating from.
- Prototyping: "make it look like this" is a legitimate way to describe intent.
- Internal tools, throwaway experiments, teaching, and design exploration.
- Recreating a **layout pattern** (a pricing table, a dashboard grid) — layout is not owned by anyone.
- Cloning a screen you have written permission to clone, or one published under a permissive licence.

## Not fine

- Cloning a third-party product's interface to **ship as your own product**, or to pass it off as the original.
- Reproducing a competitor's brand: logo, wordmark, illustrations, mascots, or photography you do not hold rights to.
- Cloning a screen in order to bypass a paywall, a login, or any access control.
- Building phishing look-alikes of banking, wallet, exchange, or identity-provider screens. This is the one case where the author will publicly recommend against the plugin's use, and the one case where a bug report will be closed without discussion.

## Practical guidance

The builders are instructed to approximate photos and illustrations with CSS and SVG, so the output is a **structural** copy rather than a pixel copy. Keep it that way: if your result would be indistinguishable from someone else's shipped product, that is the signal to stop and take the layout idea rather than the identity.

When in doubt, ask: *if the original's team saw this, would they call it inspiration or impersonation?*

## Reporting

If you believe dsh-clone is being used in a way this page forbids, open an issue with the repository and a description. Do not include credentials, private screenshots, or personal data.
