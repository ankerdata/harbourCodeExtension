#include "common.ch"

#define MAX_VALUE 100
#define SQUARE( x ) (( x ) * ( x ))

PROCEDURE Test()
   LOCAL n := SQUARE( 4 )
   IF n < MAX_VALUE
      ? n
   ENDIF
RETURN
