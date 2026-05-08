#include <hbclass.ch>

CLASS Counter
   DATA nValue AS NUMERIC INIT 0
   DATA cLabel AS CHARACTER INIT ""
   METHOD Increment()
   METHOD Reset()
ENDCLASS

METHOD Increment() CLASS Counter
   ::nValue++
RETURN Self

METHOD Reset CLASS Counter
   ::nValue := 0
RETURN Self

PROCEDURE Driver()
   LOCAL oCnt := Counter():New()
   oCnt:Increment()
   oCnt:Reset()
RETURN
