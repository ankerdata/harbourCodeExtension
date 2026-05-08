/* This is the file header
   describing what's inside */

// Adds two numbers and returns the sum
FUNCTION Add(a, b)
   LOCAL r := a + b   // trailing comment
RETURN r

PROCEDURE Documented()
   /* Inner block */
   LOCAL x := 1
   x++
RETURN

// File footer
