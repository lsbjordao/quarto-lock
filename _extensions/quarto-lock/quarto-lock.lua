-- quarto-lock
--
-- The actual encryption happens in the project post-render step. This tiny
-- filter intentionally leaves the Pandoc AST untouched; referencing it from
-- `_quarto.yml` activates the extension and its project metadata.

function Pandoc(doc)
  return doc
end
