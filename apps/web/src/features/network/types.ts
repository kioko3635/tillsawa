export interface StoreSnapshot {
  capturedAt:string; currency:string; timezone:string; branchName:string;
  sales:{count:number;grossSales:string;cashSales:string;mpesaSales:string;cardSales:string;creditSales:string;testSales:string;returned:string;refunded:string};
  expenses:{paid:string;authorized:string};
  inventory:{stockValue:string;onHandQty:string;lowStockCount:number};
  debt:{receivablesOutstanding:string;payablesOutstanding:string};
  daily:Array<{date:string;sales:string;saleCount:number;authorizedExpenses:string;paidExpenses:string}>;
  cashiers:Array<{membershipId:string;name:string;saleCount:number;sales:string}>;
  stock:Array<{id:string;sku:string;name:string;unit:string;quantity:string;price:string}>;
  stockItemCount:number;
  recentSales:Array<{id:string;receipt:string;status:string;soldAt:string;amount:string;cashier:string}>;
}
export interface NetworkStore {id:string;code:string;name:string;revoked:boolean;lastReceivedAt:string|null;stale:boolean;pairingExpiresAt:string|null;snapshot:StoreSnapshot|null}
export interface NetworkLink {id:string;branchId:string;branchName:string;hubUrl:string;storeId:string;enabled:boolean;lastSuccessAt:string|null;lastAttemptAt:string|null;lastError:string|null;pending:boolean}
