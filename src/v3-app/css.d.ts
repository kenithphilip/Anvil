// Stylesheets are imported for their side effect only (Vite injects them at
// build time), e.g. `import "./styles.css"`. TypeScript cannot resolve a .css
// file to a module, and since TypeScript 6.0 turned noUncheckedSideEffectImports
// on by default, an unresolvable side-effect import is an error.
//
// This wildcard declaration is the fix the TypeScript docs give for asset
// imports. It is deliberately narrower than turning the option off: a
// side-effect import of a .js or .ts module that does not exist is still an
// error. The empty body means a .css import has no exports, which matches how
// this app uses them; nothing here imports a value out of a stylesheet.
declare module "*.css" {}
