PROCEDURE GroupTest()
   LOCAL i := 0

   IF i == 1
      ? "one"
   ELSEIF i == 2
      ? "two"
   ELSE
      ? "other"
   ENDIF

   FOR i := 1 TO 10
      IF i > 5
         EXIT
      ENDIF
   NEXT

   DO WHILE i > 0
      i--
   ENDDO

   SWITCH i
      CASE 0
         ? "zero"
         EXIT
      CASE 1
         ? "one"
         EXIT
      OTHERWISE
         ? "many"
   ENDSWITCH

   BEGIN SEQUENCE
      Throw()
   RECOVER
      ? "caught"
   END SEQUENCE
RETURN
