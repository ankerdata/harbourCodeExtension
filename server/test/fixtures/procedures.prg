PROCEDURE Main()
   LOCAL n := 1
   LOCAL cName := "World"
   ? Greet(cName)
   n++
RETURN

FUNCTION Greet(cWho)
   LOCAL cMsg := "Hello, " + cWho
RETURN cMsg

STATIC FUNCTION Helper(x)
   LOCAL y := x * 2
RETURN y
