PROCEDURE DbTest()
   USE customers ALIAS cust
   ? cust->name
   ? cust->balance
   customers->id := 1
RETURN
