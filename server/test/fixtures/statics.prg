THREAD STATIC shSocket

STATIC nCount := 0

STATIC PROCEDURE SockDebug()
   ? shSocket, nCount
RETURN

PROCEDURE Main()
   shSocket := 1
   nCount++
   SockDebug()
RETURN
